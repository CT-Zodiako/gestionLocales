import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { AppointmentDetail } from "./agenda.ts";
import type { Database } from "./client.ts";
import {
  APPOINTMENT_STATUS,
  appointments,
  businesses,
  customers,
  services,
  whatsappChannels,
  whatsappProcessedMessages,
  type Appointment,
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

/**
 * Marks a message as being handled. Returns true for the one caller that stored the marker and false
 * for every duplicate (a retry, or a concurrent delivery of the same message): one atomic
 * `INSERT ... ON CONFLICT DO NOTHING` on the primary key.
 */
export async function claimWhatsappMessage(db: Database, input: ClaimWhatsappMessageInput): Promise<boolean> {
  const rows = await db
    .insert(whatsappProcessedMessages)
    .values(input)
    .onConflictDoNothing({ target: whatsappProcessedMessages.wamid })
    .returning({ wamid: whatsappProcessedMessages.wamid });
  return rows.length > 0;
}

/** Removes the marker so a later delivery of the same message is handled again (only when nothing was changed). */
export async function releaseWhatsappMessage(db: Database, wamid: string): Promise<void> {
  await db.delete(whatsappProcessedMessages).where(eq(whatsappProcessedMessages.wamid, wamid));
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
 * atomic UPDATE, so ownership is enforced at the moment of the write; returns null when there is nothing
 * to cancel (unknown, someone else's, past or already cancelled).
 */
export async function cancelUpcomingAppointmentForPhone(
  db: Database,
  input: PhoneAppointmentsInput & { appointmentId: string },
): Promise<Appointment | null> {
  const owned = db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, input.businessId), eq(customers.phone, input.phone)));
  const rows = await db
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
  return rows[0] ?? null;
}
