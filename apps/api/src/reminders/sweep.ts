import {
  REMINDER_KIND,
  claimDueReminders,
  loadReminderContext,
  settleReminder,
  type ClaimedReminder,
  type Database,
  type ReminderContext,
  type ReminderOutcome,
} from "@gestion/db";
import type { ReminderTemplates } from "../env.ts";
import { formatLocalTime, localDateOf } from "../whatsapp/availability.ts";
import { isPermanentSendError, type WhatsAppClient } from "../whatsapp/client.ts";
import { consoleLogger, describeError, type WhatsAppLogger } from "../whatsapp/logger.ts";
import { templateMessage, truncate } from "../whatsapp/messages.ts";

export type { ReminderTemplates } from "../env.ts";

/** A `sending` row claimed longer ago than this is taken to belong to a dead worker and is claimed again. */
export const REMINDER_LEASE_MS = 5 * 60_000;

/** Send attempts per reminder, counting claims that never finished (a crash). */
export const REMINDER_MAX_ATTEMPTS = 4;

/** Wait before attempt 2, 3 and 4 after a transient failure: 1, 5 and 30 minutes. */
export const REMINDER_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

const DEFAULT_BATCH_SIZE = 50;
/** Hard stop for one sweep, so a bug can never spin forever. */
const MAX_BATCHES = 200;
/** Template parameters are cut to this length (Meta allows far more; a name this long is a mistake). */
const PARAMETER_MAX = 60;

export interface ReminderSweepDeps {
  db: Database;
  client: WhatsAppClient;
  templates: ReminderTemplates;
  /** The clock: due times, leases and backoff all derive from it. */
  now: () => Date;
  logger?: WhatsAppLogger;
  /** Lease for a claimed row; `REMINDER_LEASE_MS` by default. */
  leaseMs?: number;
}

export interface SweepOptions {
  /** Only sweep these businesses (tests share one database). Every business when omitted. */
  businessIds?: string[];
  /** Rows claimed per round trip; the sweep keeps claiming until nothing is due. */
  batchSize?: number;
  /** Test seam: runs right after a row is claimed and before its send-time checks. */
  afterClaim?: (claim: ClaimedReminder) => Promise<void> | void;
}

export interface SweepSummary {
  /** Rows this sweep claimed. */
  claimed: number;
  sent: number;
  skipped: number;
  /** Gave up for good (a permanent error or no attempts left). */
  failed: number;
  /** Transient failure: back to pending for a later sweep. */
  retried: number;
  /** Unexpected errors (for example the database): the row stays claimed and is retaken after the lease. */
  errored: number;
}

type Result = keyof Omit<SweepSummary, "claimed">;

/** `dd/mm/yyyy` of an instant in the business timezone. */
export function formatReminderDate(timezone: string, instant: Date): string {
  const [year, month, day] = localDateOf(timezone, instant).split("-");
  return `${day}/${month}/${year}`;
}

/**
 * The four body parameters of both templates, in order: customer name (`cliente` when unknown), service name,
 * date `dd/mm/yyyy` and time `HH:mm` of the appointment in the business timezone.
 */
export function reminderParameters(context: ReminderContext): string[] {
  return [
    truncate(context.customerName ?? "", PARAMETER_MAX) || "cliente",
    truncate(context.serviceName, PARAMETER_MAX) || "cita",
    formatReminderDate(context.timezone, context.startsAt),
    formatLocalTime(context.timezone, context.startsAt),
  ];
}

/** Why a reminder must not be sent now, or null when it may go out. */
function skipReason(context: ReminderContext, recipient: string, now: Date): string | null {
  if (context.appointmentStatus !== "booked") return "Appointment was cancelled";
  if (context.startsAt.getTime() <= now.getTime()) return "Appointment is already in the past";
  if (recipient === "") return "Customer has no phone number";
  if (context.phoneNumberId === null) return "Business has no WhatsApp channel";
  return null;
}

/**
 * One pass over the reminders that are due. Each row is first claimed in the database (`pending` -> `sending`
 * with a lease, `FOR UPDATE SKIP LOCKED`) and only then sent, so concurrent sweeps in this or another process
 * never send the same row. At send time the appointment is checked again (still booked, not in the past, the
 * customer has a phone, the business has a channel). A transient failure goes back to `pending` with backoff
 * (1, 5, 30 minutes) until `REMINDER_MAX_ATTEMPTS`; a permanent one fails at once.
 *
 * Limit: if a worker dies after WhatsApp accepted the message but before the row was marked `sent`, the lease
 * expires and the row is sent once more (at most once per extra attempt, and the attempts are capped).
 */
export async function sweepReminders(deps: ReminderSweepDeps, options: SweepOptions = {}): Promise<SweepSummary> {
  const logger = deps.logger ?? consoleLogger;
  const summary: SweepSummary = { claimed: 0, sent: 0, skipped: 0, failed: 0, retried: 0, errored: 0 };

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const claims = await claimDueReminders(deps.db, {
      now: deps.now(),
      leaseMs: deps.leaseMs ?? REMINDER_LEASE_MS,
      limit: options.batchSize ?? DEFAULT_BATCH_SIZE,
      ...(options.businessIds ? { businessIds: options.businessIds } : {}),
    });
    if (claims.length === 0) break;

    summary.claimed += claims.length;
    for (const claim of claims) summary[await processClaim(deps, claim, options, logger)] += 1;
  }
  return summary;
}

async function processClaim(
  deps: ReminderSweepDeps,
  claim: ClaimedReminder,
  options: SweepOptions,
  logger: WhatsAppLogger,
): Promise<Result> {
  const fields = { reminderId: claim.id, appointmentId: claim.appointmentId, kind: claim.kind, attempt: claim.attempts };
  try {
    await options.afterClaim?.(claim);

    if (claim.attempts > REMINDER_MAX_ATTEMPTS) {
      return await settle(deps, claim, { status: "failed", error: "Gave up after repeated interrupted attempts" }, fields, logger);
    }

    const context = await loadReminderContext(deps.db, claim.id);
    const recipient = context?.customerPhone.replace(/\D/g, "") ?? "";
    const reason = context ? skipReason(context, recipient, deps.now()) : "Appointment no longer exists";
    if (reason !== null || context === null || context.phoneNumberId === null) {
      // `context.phoneNumberId === null` is already a reason; it is repeated here so the types know it is set below.
      return await settle(deps, claim, { status: "skipped", reason: reason ?? "Business has no WhatsApp channel" }, fields, logger);
    }

    const message = templateMessage({
      to: recipient,
      name: claim.kind === REMINDER_KIND.CONFIRMATION ? deps.templates.confirmation : deps.templates.reminder,
      language: deps.templates.language,
      bodyParameters: reminderParameters(context),
    });

    let messageId: string | null;
    try {
      ({ messageId } = await deps.client.sendTemplate({ phoneNumberId: context.phoneNumberId, message }));
    } catch (error) {
      return await settle(deps, claim, failureOutcome(deps, claim, error), fields, logger);
    }
    return await settle(deps, claim, { status: "sent", at: deps.now(), messageId }, fields, logger);
  } catch (error) {
    // Typically the database. The row stays `sending`: its lease expires and a later sweep retakes it.
    logger.error("reminder could not be processed", { ...fields, reason: describeError(error) });
    return "errored";
  }
}

/** Transient errors retry with backoff until the attempts run out; everything else (a permanent 4xx) fails at once. */
function failureOutcome(deps: ReminderSweepDeps, claim: ClaimedReminder, error: unknown): ReminderOutcome {
  const reason = describeError(error);
  const delay = REMINDER_RETRY_DELAYS_MS[claim.attempts - 1];
  if (isPermanentSendError(error) || claim.attempts >= REMINDER_MAX_ATTEMPTS || delay === undefined) {
    return { status: "failed", error: reason };
  }
  return { status: "retry", dueAt: new Date(deps.now().getTime() + delay), error: reason };
}

async function settle(
  deps: ReminderSweepDeps,
  claim: ClaimedReminder,
  outcome: ReminderOutcome,
  fields: Record<string, unknown>,
  logger: WhatsAppLogger,
): Promise<Result> {
  const recorded = await settleReminder(deps.db, claim, outcome);
  const result: Result = outcome.status === "retry" ? "retried" : outcome.status;
  if (!recorded) {
    // The lease was taken over while we worked; the new owner decides the outcome.
    logger.warn("reminder outcome dropped: its claim was taken over", { ...fields, outcome: outcome.status });
    return "errored";
  }

  if (outcome.status === "sent") logger.info("reminder sent", fields);
  else if (outcome.status === "skipped") logger.info("reminder skipped", { ...fields, reason: outcome.reason });
  else logger.warn(outcome.status === "retry" ? "reminder send failed, will retry" : "reminder failed", { ...fields, reason: outcome.error });
  return result;
}
