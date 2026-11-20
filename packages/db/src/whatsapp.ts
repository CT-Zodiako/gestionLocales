import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { AppointmentDetail } from "./agenda.ts";
import type { Database } from "./client.ts";
import { skipPendingReminders } from "./reminders.ts";
import {
  APPOINTMENT_STATUS,
  appointments,
  businesses,
  customers,
  services,
  whatsappChannels,
  whatsappPendingNames,
  whatsappProcessedMessages,
  type Appointment,
  type Customer,
} from "./schema.ts";

/** The business a WhatsApp phone number belongs to, with what the bot needs to talk for it. */
export interface WhatsappChannelInfo {
  businessId: string;
  businessName: string;
  /** IANA timezone of the business. */
  timezone: string;
}

/** The business that owns this WhatsApp `phone_number_id`, or null when the number is not registered. */
export async function findWhatsappChannel(db: Database, phoneNumberId: string): Promise<WhatsappChannelInfo | null> {
  const rows = await db
    .select({ businessId: businesses.id, businessName: businesses.name, timezone: businesses.timezone })
    .from(whatsappChannels)
    .innerJoin(businesses, eq(businesses.id, whatsappChannels.businessId))
    .where(eq(whatsappChannels.phoneNumberId, phoneNumberId))
    .limit(1);
  return rows[0] ?? null;
}

export type LinkWhatsappChannelResult = "linked" | "already_linked" | "other_business";

/**
 * Registers a phone number for a business. Idempotent: linking the same pair again reports
 * `already_linked`; a number that belongs to another business is never reassigned (`other_business`).
 */
export async function linkWhatsappChannel(
  db: Database,
  businessId: string,
  phoneNumberId: string,
): Promise<LinkWhatsappChannelResult> {
  const inserted = await db
    .insert(whatsappChannels)
    .values({ businessId, phoneNumberId })
    .onConflictDoNothing({ target: whatsappChannels.phoneNumberId })
    .returning({ id: whatsappChannels.id });
  if (inserted.length > 0) return "linked";

  const existing = await db
    .select({ businessId: whatsappChannels.businessId })
    .from(whatsappChannels)
    .where(eq(whatsappChannels.phoneNumberId, phoneNumberId))
    .limit(1);
  return existing[0]?.businessId === businessId ? "already_linked" : "other_business";
}

export interface ClaimWhatsappMessageInput {
  /** WhatsApp message id; globally unique. */
  wamid: string;
  businessId: string;
}

/** How long an uncompleted marker protects a message before a retry may take it over. */
export const WHATSAPP_MESSAGE_LEASE_MS = 120_000;

export interface ClaimWhatsappMessageOptions {
  /** Lease duration in milliseconds; `WHATSAPP_MESSAGE_LEASE_MS` by default. Tests shorten it. */
  leaseMs?: number;
}

/**
 * Marks a message as being handled. Returns true for the one caller that now owns it and false for every
 * other (a duplicate of a finished message, or a delivery while another one is still in flight): one atomic
 * `INSERT ... ON CONFLICT (wamid) DO UPDATE ... WHERE`.
 *
 * The marker is a lease. When no row exists it is inserted. When one exists it is taken over (`received_at`
 * moves to now, in the same statement) only if it is NOT completed and older than the lease: that is a handler
 * that died or never managed to release it, and Meta's retry must not be treated as a duplicate forever.
 * Concurrent takeovers serialize on the row lock and only the first one still sees an expired lease.
 */
export async function claimWhatsappMessage(
  db: Database,
  input: ClaimWhatsappMessageInput,
  options: ClaimWhatsappMessageOptions = {},
): Promise<boolean> {
  const leaseMs = options.leaseMs ?? WHATSAPP_MESSAGE_LEASE_MS;
  const rows = await db
    .insert(whatsappProcessedMessages)
    .values(input)
    .onConflictDoUpdate({
      target: whatsappProcessedMessages.wamid,
      set: { receivedAt: sql`now()` },
      setWhere: sql`${whatsappProcessedMessages.completedAt} is null and ${whatsappProcessedMessages.receivedAt} < now() - ${leaseMs}::double precision * interval '1 millisecond'`,
    })
    .returning({ wamid: whatsappProcessedMessages.wamid });
  return rows.length > 0;
}

/** Marks handling as finished without needing a retry, so the lease can never take the marker over. */
export async function completeWhatsappMessage(db: Database, wamid: string): Promise<void> {
  await db
    .update(whatsappProcessedMessages)
    .set({ completedAt: sql`now()` })
    .where(and(eq(whatsappProcessedMessages.wamid, wamid), isNull(whatsappProcessedMessages.completedAt)));
}

/** Removes the marker so a later delivery of the same message is handled again (only when nothing was changed). */
export async function releaseWhatsappMessage(db: Database, wamid: string): Promise<void> {
  await db.delete(whatsappProcessedMessages).where(eq(whatsappProcessedMessages.wamid, wamid));
}

/** The stored marker of a message id, or null: lets callers and tests tell "in flight" from "completed". */
export async function getWhatsappMessageMarker(
  db: Database,
  wamid: string,
): Promise<{ businessId: string; receivedAt: Date; completedAt: Date | null } | null> {
  const rows = await db
    .select({
      businessId: whatsappProcessedMessages.businessId,
      receivedAt: whatsappProcessedMessages.receivedAt,
      completedAt: whatsappProcessedMessages.completedAt,
    })
    .from(whatsappProcessedMessages)
    .where(eq(whatsappProcessedMessages.wamid, wamid))
    .limit(1);
  return rows[0] ?? null;
}

export interface PhoneAppointmentsInput {
  businessId: string;
  /** Customer phone as stored (digits only). */
  phone: string;
  /** "Upcoming" means starting after this instant. */
  from: Date;
}

const detailColumns = {
  id: appointments.id,
  customerId: appointments.customerId,
  serviceId: appointments.serviceId,
  startsAt: appointments.startsAt,
  endsAt: appointments.endsAt,
  status: appointments.status,
  customerPhone: customers.phone,
  customerName: customers.name,
  serviceName: services.name,
  servicePrice: services.price,
};

/** Booked appointments of one customer phone that start after `from`, soonest first; `offset` skips earlier ones (paging). */
export async function listUpcomingAppointmentsForPhone(
  db: Database,
  input: PhoneAppointmentsInput & { limit: number; offset?: number },
): Promise<AppointmentDetail[]> {
  return db
    .select(detailColumns)
    .from(appointments)
    .innerJoin(customers, and(eq(customers.id, appointments.customerId), eq(customers.businessId, appointments.businessId)))
    .innerJoin(services, and(eq(services.id, appointments.serviceId), eq(services.businessId, appointments.businessId)))
    .where(
      and(
        eq(appointments.businessId, input.businessId),
        eq(customers.phone, input.phone),
        eq(appointments.status, APPOINTMENT_STATUS.BOOKED),
        gt(appointments.startsAt, input.from),
      ),
    )
    .orderBy(asc(appointments.startsAt), asc(appointments.id))
    .limit(input.limit)
    .offset(input.offset ?? 0);
}

/**
 * The booked appointment of that phone for exactly this service at exactly this start, or null. Lets the bot tell
 * "you already booked this" apart from "someone else took it".
 */
export async function findBookedAppointmentForPhoneAt(
  db: Database,
  input: { businessId: string; phone: string; serviceId: string; startsAt: Date },
): Promise<Appointment | null> {
  const rows = await db
    .select({ appointment: appointments })
    .from(appointments)
    .innerJoin(customers, and(eq(customers.id, appointments.customerId), eq(customers.businessId, appointments.businessId)))
    .where(
      and(
        eq(appointments.businessId, input.businessId),
        eq(customers.phone, input.phone),
        eq(appointments.serviceId, input.serviceId),
        eq(appointments.startsAt, input.startsAt),
        eq(appointments.status, APPOINTMENT_STATUS.BOOKED),
      ),
    )
    .limit(1);
  return rows[0]?.appointment ?? null;
}

/** One booked, upcoming appointment, only if it belongs to that phone within that business. */
export async function findUpcomingAppointmentForPhone(
  db: Database,
  input: PhoneAppointmentsInput & { appointmentId: string },
): Promise<AppointmentDetail | null> {
  const rows = await db
    .select(detailColumns)
    .from(appointments)
    .innerJoin(customers, and(eq(customers.id, appointments.customerId), eq(customers.businessId, appointments.businessId)))
    .innerJoin(services, and(eq(services.id, appointments.serviceId), eq(services.businessId, appointments.businessId)))
    .where(
      and(
        eq(appointments.id, input.appointmentId),
        eq(appointments.businessId, input.businessId),
        eq(customers.phone, input.phone),
        eq(appointments.status, APPOINTMENT_STATUS.BOOKED),
        gt(appointments.startsAt, input.from),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Cancels a booked, upcoming appointment, only when it belongs to that phone within that business. One
 * atomic UPDATE, so ownership is enforced at the moment of the write (its pending reminders are skipped in the
 * same transaction); returns null when there is nothing to cancel (unknown, someone else's, past or already cancelled).
 */
export async function cancelUpcomingAppointmentForPhone(
  db: Database,
  input: PhoneAppointmentsInput & { appointmentId: string },
): Promise<Appointment | null> {
  const owned = db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, input.businessId), eq(customers.phone, input.phone)));
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(appointments)
      .set({ status: APPOINTMENT_STATUS.CANCELLED })
      .where(
        and(
          eq(appointments.id, input.appointmentId),
          eq(appointments.businessId, input.businessId),
          eq(appointments.status, APPOINTMENT_STATUS.BOOKED),
          gt(appointments.startsAt, input.from),
          inArray(appointments.customerId, owned),
        ),
      )
      .returning();
    const cancelled = rows[0];
    if (!cancelled) return null;
    await skipPendingReminders(tx, cancelled);
    return cancelled;
  });
}

/** How long a name question stays open. */
export const PENDING_NAME_TTL_MS = 10 * 60_000;

/** Invalid names the bot accepts before it gives up on the question (the second one ends it). */
export const PENDING_NAME_MAX_ATTEMPTS = 2;

export interface PendingNameKey {
  businessId: string;
  /** Sender number, digits only. */
  phone: string;
}

/** The customer of that phone in the business, or null when there is none yet. */
export async function findCustomerByPhone(db: Database, businessId: string, phone: string): Promise<Customer | null> {
  const rows = await db
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.phone, phone)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Opens (or reopens) the name question for that sender: one row per business + phone, so asking again resets the
 * attempts and the 10 minutes. `now` is the caller's clock.
 */
export async function startPendingName(db: Database, input: PendingNameKey & { now: Date }): Promise<void> {
  const expiresAt = new Date(input.now.getTime() + PENDING_NAME_TTL_MS);
  await db
    .insert(whatsappPendingNames)
    .values({ businessId: input.businessId, phone: input.phone, expiresAt })
    .onConflictDoUpdate({
      target: [whatsappPendingNames.businessId, whatsappPendingNames.phone],
      set: { attempts: 0, expiresAt, createdAt: sql`now()` },
    });
}

/** Closes the name question of that sender, if any. */
export async function clearPendingName(db: Database, input: PendingNameKey): Promise<void> {
  await db
    .delete(whatsappPendingNames)
    .where(and(eq(whatsappPendingNames.businessId, input.businessId), eq(whatsappPendingNames.phone, input.phone)));
}

/**
 * Consumes an open name question and saves the name on the customer (created when missing), in one transaction.
 * Only the caller that deletes the row wins, so two racing texts cannot both be taken as the name. A customer
 * that already has a name keeps it (it is never overwritten). Returns null when no question was open.
 */
export async function completePendingName(
  db: Database,
  input: PendingNameKey & { name: string; now: Date },
): Promise<Customer | null> {
  return db.transaction(async (tx) => {
    const taken = await tx
      .delete(whatsappPendingNames)
      .where(
        and(
          eq(whatsappPendingNames.businessId, input.businessId),
          eq(whatsappPendingNames.phone, input.phone),
          gt(whatsappPendingNames.expiresAt, input.now),
        ),
      )
      .returning({ phone: whatsappPendingNames.phone });
    if (taken.length === 0) return null;

    const rows = await tx
      .insert(customers)
      .values({ businessId: input.businessId, phone: input.phone, name: input.name })
      .onConflictDoUpdate({
        target: [customers.businessId, customers.phone],
        set: {
          name: sql`case when ${customers.name} is null or btrim(${customers.name}) = '' then excluded.name else ${customers.name} end`,
        },
      })
      .returning();
    const customer = rows[0];
    if (!customer) throw new Error("Could not save the customer name");
    return customer;
  });
}

/**
 * Counts one invalid answer to an open question. The first leaves it open (`retry`); once
 * `PENDING_NAME_MAX_ATTEMPTS` is reached the question is closed (`gave_up`). Returns null when no question was
 * open. The expiry is not extended.
 */
export async function rejectPendingName(
  db: Database,
  input: PendingNameKey & { now: Date },
): Promise<"retry" | "gave_up" | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(whatsappPendingNames)
      .set({ attempts: sql`${whatsappPendingNames.attempts} + 1` })
      .where(
        and(
          eq(whatsappPendingNames.businessId, input.businessId),
          eq(whatsappPendingNames.phone, input.phone),
          gt(whatsappPendingNames.expiresAt, input.now),
        ),
      )
      .returning({ attempts: whatsappPendingNames.attempts });
    const row = rows[0];
    if (!row) return null;
    if (row.attempts < PENDING_NAME_MAX_ATTEMPTS) return "retry";

    await tx
      .delete(whatsappPendingNames)
      .where(and(eq(whatsappPendingNames.businessId, input.businessId), eq(whatsappPendingNames.phone, input.phone)));
    return "gave_up";
  });
}
