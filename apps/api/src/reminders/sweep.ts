import {
  REMINDER_KIND,
  claimDueReminders,
  deferReminder,
  loadReminderContext,
  settleReminder,
  type ClaimedReminder,
  type Database,
  type ReminderContext,
  type ReminderOutcome,
} from "@gestion/db";
import type { ReminderTemplates } from "../env.ts";
import { formatLocalTime, localDateOf } from "../whatsapp/availability.ts";
import { isAuthSendError, isPermanentSendError, type WhatsAppClient } from "../whatsapp/client.ts";
import { consoleLogger, describeError, type WhatsAppLogger } from "../whatsapp/logger.ts";
import { templateMessage, truncate } from "../whatsapp/messages.ts";

export type { ReminderTemplates } from "../env.ts";

/** A `sending` row claimed longer ago than this is taken to belong to a dead worker and is claimed again. */
export const REMINDER_LEASE_MS = 5 * 60_000;

/** Send attempts per reminder, counting claims that never finished (a crash). */
export const REMINDER_MAX_ATTEMPTS = 4;

/** Wait before attempt 2, 3 and 4 after a transient failure: 1, 5 and 30 minutes. */
export const REMINDER_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

/** Most rows one sweep sends unless `batchSize` says otherwise. */
const DEFAULT_BATCH_SIZE = 50;

/** A sweep stops claiming new rows after this long (on the injected clock), well inside the lease and the next minute's sweep. */
export const REMINDER_SWEEP_BUDGET_MS = 4 * 60_000;

/** After an authentication error from Graph, sweeps send nothing for this long. */
export const REMINDER_AUTH_PAUSE_MS = 10 * 60_000;

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

/**
 * Pauses sweeps after Graph refused the credentials (HTTP 401/403, Graph code 190): every send would fail the same
 * way, so the sweep stops and nothing is claimed or sent until the pause ends. Once it has ended, the next sweep
 * is tried (it stops again at its first row if the token is still bad) and a successful send closes the breaker,
 * unless another sweep opened it after that send began.
 * In memory: it belongs to one process.
 */
export interface ReminderBreaker {
  /** Whether sweeps must send nothing at `now`. */
  isOpen: (now: Date) => boolean;
  /** Pauses sweeps until `now` plus the pause. */
  open: (now: Date) => void;
  /** The breaker's state now, to be handed back to `close`: it changes every time the breaker opens. */
  mark: () => number;
  /**
   * Resumes sweeping, but only if the breaker has not been (re)opened since `since` was taken with `mark`: a send
   * that started before another sweep's authentication error says nothing about the token's state after it.
   */
  close: (since: number) => void;
}

export function createReminderBreaker(pauseMs: number = REMINDER_AUTH_PAUSE_MS): ReminderBreaker {
  let pausedUntil: number | null = null;
  /** Counts openings: a send that began under an older value must not close a newer opening. */
  let generation = 0;
  return {
    isOpen: (now) => pausedUntil !== null && now.getTime() < pausedUntil,
    open: (now) => {
      generation += 1;
      pausedUntil = now.getTime() + pauseMs;
    },
    mark: () => generation,
    close: (since) => {
      if (since === generation) pausedUntil = null;
    },
  };
}

/** The breaker of each WhatsApp client: one set of credentials, one breaker, shared by every sweep of the process. */
const breakers = new WeakMap<object, ReminderBreaker>();

function breakerOf(client: WhatsAppClient): ReminderBreaker {
  let breaker = breakers.get(client);
  if (!breaker) {
    breaker = createReminderBreaker();
    breakers.set(client, breaker);
  }
  return breaker;
}

export interface SweepOptions {
  /** Only sweep these businesses (tests share one database). Every business when omitted. */
  businessIds?: string[];
  /** Most rows one sweep claims and sends (50 by default); rows are claimed one at a time, just before each send. */
  batchSize?: number;
  /** Stop claiming new rows after this long on the injected clock; `REMINDER_SWEEP_BUDGET_MS` by default. */
  timeBudgetMs?: number;
  /** Raised on shutdown: checked between rows, the row in flight is always finished. */
  signal?: AbortSignal;
  /** Replaces the per-client breaker (tests need a fresh one). */
  breaker?: ReminderBreaker;
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
  /** Authentication error from Graph: back to pending with the attempt refunded, and the breaker opened. */
  deferred: number;
  /** Unexpected errors (for example the database): the row stays claimed and is retaken after the lease. */
  errored: number;
  /** The breaker was open: the sweep stopped (or never started) because Graph refused the credentials. */
  paused: boolean;
}

type Result = Exclude<keyof SweepSummary, "claimed" | "paused">;

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
 * One pass over the reminders that are due, one row at a time: a row is claimed in the database (`pending` ->
 * `sending` with a lease, `FOR UPDATE SKIP LOCKED`), sent, settled, and only then is the next one claimed. So
 * concurrent sweeps in this or another process never send the same row, and the lease only has to outlast one
 * send. The sweep stops when nothing is due, after `batchSize` rows, when the time budget is used up, when the
 * stop signal is raised, or when the breaker opens (Graph refused the credentials). At send time the appointment
 * is checked again (still booked, not in the past, the customer has a phone, the business has a channel). A
 * transient failure goes back to `pending` with backoff (1, 5, 30 minutes) until `REMINDER_MAX_ATTEMPTS`; a
 * permanent one fails at once; an authentication error defers the row without costing an attempt.
 *
 * Limits: a message can be sent twice when the worker dies, or its response is lost, after WhatsApp accepted it
 * but before the row was marked `sent` (the lease then expires, or a timeout/5xx is retried); the attempts are
 * capped. A single send that outlives the lease can be repeated by another instance.
 */
export async function sweepReminders(deps: ReminderSweepDeps, options: SweepOptions = {}): Promise<SweepSummary> {
  const logger = deps.logger ?? consoleLogger;
  const breaker = options.breaker ?? breakerOf(deps.client);
  const summary: SweepSummary = { claimed: 0, sent: 0, skipped: 0, failed: 0, retried: 0, deferred: 0, errored: 0, paused: false };
  const maxRows = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const budgetMs = options.timeBudgetMs ?? REMINDER_SWEEP_BUDGET_MS;
  const startedAt = deps.now().getTime();

  while (summary.claimed < maxRows) {
    if (options.signal?.aborted) break;
    if (breaker.isOpen(deps.now())) break;
    if (deps.now().getTime() - startedAt >= budgetMs) break;

    const [claim] = await claimDueReminders(deps.db, {
      now: deps.now(),
      leaseMs: deps.leaseMs ?? REMINDER_LEASE_MS,
      limit: 1,
      ...(options.businessIds ? { businessIds: options.businessIds } : {}),
    });
    if (!claim) break;

    summary.claimed += 1;
    summary[await processClaim(deps, claim, options, breaker, logger)] += 1;
  }

  summary.paused = breaker.isOpen(deps.now());
  return summary;
}

async function processClaim(
  deps: ReminderSweepDeps,
  claim: ClaimedReminder,
  options: SweepOptions,
  breaker: ReminderBreaker,
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

    const breakerMark = breaker.mark();
    let messageId: string | null;
    try {
      ({ messageId } = await deps.client.sendTemplate({ phoneNumberId: context.phoneNumberId, message }));
    } catch (error) {
      if (isAuthSendError(error)) return await deferAfterAuthError(deps, claim, error, breaker, fields, logger);
      return await settle(deps, claim, failureOutcome(deps, claim, error), fields, logger);
    }
    breaker.close(breakerMark);
    return await settle(deps, claim, { status: "sent", at: deps.now(), messageId }, fields, logger);
  } catch (error) {
    // Typically the database. The row stays `sending`: its lease expires and a later sweep retakes it.
    logger.error("reminder could not be processed", { ...fields, reason: describeError(error) });
    return "errored";
  }
}

/**
 * Graph refused the credentials: that says nothing about this row. The breaker opens (so no sweep sends anything
 * for a while), the row goes back to `pending` with its attempt refunded, and one error line is logged.
 */
async function deferAfterAuthError(
  deps: ReminderSweepDeps,
  claim: ClaimedReminder,
  error: unknown,
  breaker: ReminderBreaker,
  fields: Record<string, unknown>,
  logger: WhatsAppLogger,
): Promise<Result> {
  const reason = describeError(error);
  breaker.open(deps.now());
  logger.error("WhatsApp authentication failed; pausing reminders", { ...fields, reason, pauseMinutes: REMINDER_AUTH_PAUSE_MS / 60_000 });

  const recorded = await deferReminder(deps.db, claim, `${reason}; reminders paused, will retry`);
  if (!recorded) {
    logger.warn("reminder outcome dropped: its claim was taken over", { ...fields, outcome: "deferred" });
    return "errored";
  }
  return "deferred";
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
