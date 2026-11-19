import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  APPOINTMENT_STATUS,
  REMINDER_KIND,
  REMINDER_STATUS,
  appointmentReminders,
  appointments,
  businesses,
  customers,
  services,
  whatsappChannels,
  type Appointment,
  type AppointmentReminder,
  type ReminderKind,
} from "./schema.ts";

export { REMINDER_KIND, REMINDER_STATUS } from "./schema.ts";

/** A transaction handle, as `db.transaction` gives it. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The 24 h reminder is due this long before the appointment starts. */
export const REMINDER_LEAD_MS = 24 * 60 * 60_000;

/** How the data layer should treat reminders when it writes an appointment. */
export interface AppointmentWriteOptions {
  /**
   * Create reminders for a new appointment, and create a missing 24 h reminder when an appointment is moved far
   * enough away. Off by default: nothing is scheduled unless the caller (the server, when reminders are
   * enabled) asks for it. Cancelling and re-timing existing pending reminders never depends on it.
   */
  scheduleReminders?: boolean;
  /** Clock for reminder times; the system clock by default. Tests inject theirs. */
  now?: () => Date;
}

export function writeClock(options: AppointmentWriteOptions | undefined): Date {
  return (options?.now ?? (() => new Date()))();
}

/** Short reason stored in `last_error` when a reminder is skipped by the data layer. */
export const SKIPPED_BY_CANCELLATION = "Appointment was cancelled";
export const SKIPPED_BY_MOVE = "Reminder time already passed after the appointment was moved";

/**
 * Inserts the reminders of a freshly created appointment, inside the caller's transaction: a confirmation due
 * `now` and a 24 h reminder due 24 h before the start. A cancelled appointment or one that has already
 * started is never reminded; a 24 h reminder whose due time is not in the future is left out (the confirmation
 * covers it).
 */
export async function scheduleAppointmentReminders(tx: Transaction, appointment: Appointment, now: Date): Promise<void> {
  if (appointment.status !== APPOINTMENT_STATUS.BOOKED || appointment.startsAt.getTime() <= now.getTime()) return;

  const rows: Array<typeof appointmentReminders.$inferInsert> = [
    { businessId: appointment.businessId, appointmentId: appointment.id, kind: REMINDER_KIND.CONFIRMATION, dueAt: now },
  ];
  const dayBefore = new Date(appointment.startsAt.getTime() - REMINDER_LEAD_MS);
  if (dayBefore.getTime() > now.getTime()) {
    rows.push({ businessId: appointment.businessId, appointmentId: appointment.id, kind: REMINDER_KIND.REMINDER_24H, dueAt: dayBefore });
  }
  await tx.insert(appointmentReminders).values(rows).onConflictDoNothing();
}

/** Marks the pending reminders of an appointment as skipped (cancellation). Rows already sending or sent are left alone. */
export async function skipPendingReminders(tx: Transaction, appointment: Pick<Appointment, "id" | "businessId">): Promise<void> {
  await tx
    .update(appointmentReminders)
    .set({ status: REMINDER_STATUS.SKIPPED, lastError: SKIPPED_BY_CANCELLATION })
    .where(
      and(
        eq(appointmentReminders.appointmentId, appointment.id),
        eq(appointmentReminders.businessId, appointment.businessId),
        eq(appointmentReminders.status, REMINDER_STATUS.PENDING),
      ),
    );
}

/**
 * Recomputes the 24 h reminder of a moved appointment: a pending one is re-timed (and skipped when its new due
 * time is not in the future); a missing or skipped one is (re)created when `schedule` is set and its due time is
 * in the future. The confirmation is never touched: the new time is not re-confirmed. A reminder that is
 * sending, sent or failed is left alone.
 */
export async function retimeDayBeforeReminder(
  tx: Transaction,
  appointment: Pick<Appointment, "id" | "businessId" | "startsAt">,
  now: Date,
  schedule: boolean,
): Promise<void> {
  const dueAt = new Date(appointment.startsAt.getTime() - REMINDER_LEAD_MS);
  const inFuture = dueAt.getTime() > now.getTime();
  const revivable = schedule ? [REMINDER_STATUS.PENDING, REMINDER_STATUS.SKIPPED] : [REMINDER_STATUS.PENDING];

  const changes = inFuture
    ? { dueAt, status: REMINDER_STATUS.PENDING, attempts: 0, claimedAt: null, lastError: null }
    : { dueAt, status: REMINDER_STATUS.SKIPPED, claimedAt: null, lastError: SKIPPED_BY_MOVE };
  const updated = await tx
    .update(appointmentReminders)
    .set(changes)
    .where(
      and(
        eq(appointmentReminders.appointmentId, appointment.id),
        eq(appointmentReminders.businessId, appointment.businessId),
        eq(appointmentReminders.kind, REMINDER_KIND.REMINDER_24H),
        inArray(appointmentReminders.status, revivable),
      ),
    )
    .returning({ id: appointmentReminders.id });

  if (updated.length === 0 && schedule && inFuture) {
    await tx
      .insert(appointmentReminders)
      .values({ businessId: appointment.businessId, appointmentId: appointment.id, kind: REMINDER_KIND.REMINDER_24H, dueAt })
      .onConflictDoNothing();
  }
}

/** Reminders of one appointment, ordered by kind (confirmation first). Not business-scoped: for tests and diagnostics. */
export async function listRemindersForAppointment(db: Database, appointmentId: string): Promise<AppointmentReminder[]> {
  return db
    .select()
    .from(appointmentReminders)
    .where(eq(appointmentReminders.appointmentId, appointmentId))
    .orderBy(asc(appointmentReminders.kind));
}

/** Every reminder of a business, ordered by due time and kind. */
export async function listRemindersForBusiness(db: Database, businessId: string): Promise<AppointmentReminder[]> {
  return db
    .select()
    .from(appointmentReminders)
    .where(eq(appointmentReminders.businessId, businessId))
    .orderBy(asc(appointmentReminders.dueAt), asc(appointmentReminders.kind), asc(appointmentReminders.id));
}

export interface ClaimDueRemindersInput {
  /** The sweep's clock: due times and the lease are compared against it. */
  now: Date;
  /** A `sending` row claimed longer ago than this is a worker that died: it can be claimed again. */
  leaseMs: number;
  /** Most rows to claim in this call. */
  limit: number;
  /** Restrict the claim to these businesses (tests share one database). All businesses when omitted. */
  businessIds?: string[];
}

/** A reminder this caller now owns until it settles it (or its lease expires). */
export interface ClaimedReminder {
  id: string;
  businessId: string;
  appointmentId: string;
  kind: ReminderKind;
  /** Attempts started, including this one. */
  attempts: number;
  /** The claim's token: every `settleReminder` of this claim must present it. */
  claimedAt: Date;
}

/**
 * Atomically moves due reminders to `sending` and returns them: `pending` rows whose time has come, and
 * `sending` rows whose lease expired. One statement, `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`,
 * so concurrent callers never get the same row: a row locked by another claimer is skipped, and one that
 * another claimer already moved is no longer selected once the lock is acquired. Each claim counts an attempt.
 */
export async function claimDueReminders(db: Database, input: ClaimDueRemindersInput): Promise<ClaimedReminder[]> {
  if (input.businessIds?.length === 0) return [];

  const staleBefore = new Date(input.now.getTime() - input.leaseMs);
  const due = db
    .select({ id: appointmentReminders.id })
    .from(appointmentReminders)
    .where(
      and(
        or(
          and(eq(appointmentReminders.status, REMINDER_STATUS.PENDING), lte(appointmentReminders.dueAt, input.now)),
          and(eq(appointmentReminders.status, REMINDER_STATUS.SENDING), lte(appointmentReminders.claimedAt, staleBefore)),
        ),
        input.businessIds ? inArray(appointmentReminders.businessId, input.businessIds) : undefined,
      ),
    )
    .orderBy(asc(appointmentReminders.dueAt), asc(appointmentReminders.id))
    .limit(input.limit)
    .for("update", { skipLocked: true });

  const rows = await db
    .update(appointmentReminders)
    .set({
      status: REMINDER_STATUS.SENDING,
      claimedAt: input.now,
      attempts: sql`${appointmentReminders.attempts} + 1`,
    })
    .where(inArray(appointmentReminders.id, due))
    .returning({
      id: appointmentReminders.id,
      businessId: appointmentReminders.businessId,
      appointmentId: appointmentReminders.appointmentId,
      kind: appointmentReminders.kind,
      attempts: appointmentReminders.attempts,
      claimedAt: appointmentReminders.claimedAt,
    });

  return rows.map((row) => ({ ...row, claimedAt: row.claimedAt ?? input.now }));
}

/** What the sweep needs to know about a claimed reminder at send time. */
export interface ReminderContext {
  appointmentStatus: Appointment["status"];
  startsAt: Date;
  customerPhone: string;
  customerName: string | null;
  serviceName: string;
  /** IANA timezone of the business. */
  timezone: string;
  /** The business's WhatsApp number (Meta's `phone_number_id`), or null when none is registered. */
  phoneNumberId: string | null;
}

/** The appointment, customer, service, business timezone and WhatsApp channel behind a reminder; null when the appointment is gone. */
export async function loadReminderContext(db: Database, reminderId: string): Promise<ReminderContext | null> {
  const rows = await db
    .select({
      appointmentStatus: appointments.status,
      startsAt: appointments.startsAt,
      customerPhone: customers.phone,
      customerName: customers.name,
      serviceName: services.name,
      timezone: businesses.timezone,
      phoneNumberId: sql<string | null>`(
        select ${whatsappChannels.phoneNumberId} from ${whatsappChannels}
        where ${whatsappChannels.businessId} = ${appointmentReminders.businessId}
        order by ${whatsappChannels.createdAt}, ${whatsappChannels.id} limit 1
      )`,
    })
    .from(appointmentReminders)
    .innerJoin(
      appointments,
      and(eq(appointments.id, appointmentReminders.appointmentId), eq(appointments.businessId, appointmentReminders.businessId)),
    )
    .innerJoin(customers, and(eq(customers.id, appointments.customerId), eq(customers.businessId, appointments.businessId)))
    .innerJoin(services, and(eq(services.id, appointments.serviceId), eq(services.businessId, appointments.businessId)))
    .innerJoin(businesses, eq(businesses.id, appointmentReminders.businessId))
    .where(eq(appointmentReminders.id, reminderId))
    .limit(1);
  return rows[0] ?? null;
}

/** How a claimed reminder ended. */
export type ReminderOutcome =
  | { status: "sent"; at: Date; messageId: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  /** Back to `pending`, due again at `dueAt`. */
  | { status: "retry"; dueAt: Date; error: string };

/**
 * Records how a claim ended. Guarded by the claim: it only applies while the row is still `sending` with the
 * same `claimedAt`, so a worker whose lease was already taken over cannot overwrite the new owner's outcome.
 * Returns whether the outcome was recorded.
 */
export async function settleReminder(
  db: Database,
  claim: Pick<ClaimedReminder, "id" | "claimedAt">,
  outcome: ReminderOutcome,
): Promise<boolean> {
  const changes = (() => {
    switch (outcome.status) {
      case "sent":
        return { status: REMINDER_STATUS.SENT, sentAt: outcome.at, whatsappMessageId: outcome.messageId, lastError: null, claimedAt: null };
      case "skipped":
        return { status: REMINDER_STATUS.SKIPPED, lastError: outcome.reason, claimedAt: null };
      case "failed":
        return { status: REMINDER_STATUS.FAILED, lastError: outcome.error, claimedAt: null };
      case "retry":
        return { status: REMINDER_STATUS.PENDING, dueAt: outcome.dueAt, lastError: outcome.error, claimedAt: null };
    }
  })();

  const rows = await db
    .update(appointmentReminders)
    .set(changes)
    .where(
      and(
        eq(appointmentReminders.id, claim.id),
        eq(appointmentReminders.status, REMINDER_STATUS.SENDING),
        eq(appointmentReminders.claimedAt, claim.claimedAt),
      ),
    )
    .returning({ id: appointmentReminders.id });
  return rows.length > 0;
}

/**
 * Puts a claimed reminder back to `pending` without consuming its attempt (the claim's increment is refunded) and
 * keeps it due, noting why in `last_error`. For failures that say nothing about this row, such as a rejected
 * access token: the sweep pauses and the row is sent once the cause is fixed, still on its first attempt.
 * Guarded by the claim exactly like `settleReminder`; returns whether the row was changed.
 */
export async function deferReminder(db: Database, claim: Pick<ClaimedReminder, "id" | "claimedAt">, note: string): Promise<boolean> {
  const rows = await db
    .update(appointmentReminders)
    .set({
      status: REMINDER_STATUS.PENDING,
      attempts: sql`greatest(${appointmentReminders.attempts} - 1, 0)`,
      lastError: note,
      claimedAt: null,
    })
    .where(
      and(
        eq(appointmentReminders.id, claim.id),
        eq(appointmentReminders.status, REMINDER_STATUS.SENDING),
        eq(appointmentReminders.claimedAt, claim.claimedAt),
      ),
    )
    .returning({ id: appointmentReminders.id });
  return rows.length > 0;
}
