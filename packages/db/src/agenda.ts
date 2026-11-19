import { and, asc, eq, gt, lt } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  APPOINTMENT_STATUS,
  appointmentReminders,
  appointments,
  businesses,
  customers,
  openingHours,
  services,
  whatsappChannels,
  whatsappProcessedMessages,
  type Appointment,
  type Customer,
  type OpeningHour,
  type Service,
} from "./schema.ts";
import {
  retimeDayBeforeReminder,
  scheduleAppointmentReminders,
  skipPendingReminders,
  writeClock,
  type AppointmentWriteOptions,
} from "./reminders.ts";

/** Postgres SQLSTATE for exclusion_violation. */
const EXCLUSION_VIOLATION = "23P01";

/** Postgres SQLSTATEs for deadlock_detected and serialization_failure: the statement was rolled back and may be retried. */
const RETRYABLE_CONFLICTS: readonly string[] = ["40P01", "40001"];

/** Thrown when an appointment overlaps another booked one of the same business. */
export class SlotTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super("The requested time slot is already taken", options);
    this.name = "SlotTakenError";
  }
}

/** Finds a Postgres error code in the error or its cause chain (drizzle wraps driver errors). */
function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Runs one atomic write against the booking constraint. An exclusion violation, or a
 * deadlock/serialization failure that persists after one retry, means the slot is not free.
 */
async function withSlotConflicts<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === EXCLUSION_VIOLATION) throw new SlotTakenError({ cause: error });
      if (code !== undefined && RETRYABLE_CONFLICTS.includes(code)) {
        if (attempt === 0) continue;
        throw new SlotTakenError({ cause: error });
      }
      throw error;
    }
  }
}

function firstRow<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Could not save ${what}`);
  return row;
}

export interface UpsertCustomerInput {
  businessId: string;
  phone: string;
  name?: string | null;
}

/** One customer per business+phone; an existing one is returned (its name updated only when one is given). */
export async function upsertCustomer(db: Database, input: UpsertCustomerInput): Promise<Customer> {
  const name = input.name ?? null;
  const rows = await db
    .insert(customers)
    .values({ businessId: input.businessId, phone: input.phone, name })
    .onConflictDoUpdate({
      target: [customers.businessId, customers.phone],
      set: name === null ? { phone: input.phone } : { name },
    })
    .returning();
  return firstRow(rows, "customer");
}

export interface CreateServiceInput {
  businessId: string;
  name: string;
  durationMinutes: number;
  active?: boolean;
}

export async function createService(db: Database, input: CreateServiceInput): Promise<Service> {
  const rows = await db.insert(services).values(input).returning();
  return firstRow(rows, "service");
}

/** Services of the business, oldest first. */
export async function listServices(db: Database, businessId: string): Promise<Service[]> {
  return db
    .select()
    .from(services)
    .where(eq(services.businessId, businessId))
    .orderBy(asc(services.createdAt), asc(services.name));
}

/** A service of the business, or null when the id is unknown or belongs to another business. */
export async function findService(db: Database, businessId: string, serviceId: string): Promise<Service | null> {
  const rows = await db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.businessId, businessId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface OpeningRange {
  weekday: number;
  /** `HH:MM` or `HH:MM:SS`. */
  opensAt: string;
  closesAt: string;
}

/** Replaces the whole weekly schedule of the business in one transaction. */
export async function setOpeningHours(
  db: Database,
  businessId: string,
  ranges: OpeningRange[],
): Promise<OpeningHour[]> {
  return db.transaction(async (tx) => {
    await tx.delete(openingHours).where(eq(openingHours.businessId, businessId));
    if (ranges.length === 0) return [];
    return tx
      .insert(openingHours)
      .values(ranges.map((range) => ({ ...range, businessId })))
      .returning();
  });
}

/** The weekly schedule of the business, ordered by weekday and opening time. */
export async function listOpeningHours(db: Database, businessId: string): Promise<OpeningHour[]> {
  return db
    .select()
    .from(openingHours)
    .where(eq(openingHours.businessId, businessId))
    .orderBy(asc(openingHours.weekday), asc(openingHours.opensAt));
}

export interface CreateAppointmentInput {
  businessId: string;
  customerId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Books a slot; throws `SlotTakenError` when it overlaps a booked appointment of the business. With
 * `options.scheduleReminders` the appointment and its reminders are written in one transaction, so a refused
 * slot leaves no reminder behind.
 */
export async function createAppointment(
  db: Database,
  input: CreateAppointmentInput,
  options?: AppointmentWriteOptions,
): Promise<Appointment> {
  return withSlotConflicts(async () => {
    if (!options?.scheduleReminders) {
      const rows = await db.insert(appointments).values(input).returning();
      return firstRow(rows, "appointment");
    }
    return db.transaction(async (tx) => {
      const appointment = firstRow(await tx.insert(appointments).values(input).returning(), "appointment");
      await scheduleAppointmentReminders(tx, appointment, writeClock(options));
      return appointment;
    });
  });
}

/** A booked or cancelled appointment of the business; null when unknown or of another business. */
export async function findAppointment(
  db: Database,
  businessId: string,
  appointmentId: string,
): Promise<Appointment | null> {
  const rows = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.businessId, businessId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Cancels a booked appointment of the business, freeing its slot, and skips its pending reminders in the same
 * transaction; null when there is none to cancel.
 */
export async function cancelAppointment(
  db: Database,
  businessId: string,
  appointmentId: string,
): Promise<Appointment | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(appointments)
      .set({ status: APPOINTMENT_STATUS.CANCELLED })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.businessId, businessId),
          eq(appointments.status, APPOINTMENT_STATUS.BOOKED),
        ),
      )
      .returning();
    const cancelled = rows[0];
    if (!cancelled) return null;
    await skipPendingReminders(tx, cancelled);
    return cancelled;
  });
}

/**
 * Moves a booked appointment of the business to `[newStartsAt, newEndsAt)`; the caller computes the
 * end from epoch milliseconds so the duration never depends on database interval arithmetic.
 * One atomic UPDATE: throws `SlotTakenError` when the new range overlaps another booked
 * appointment (or a deadlock persists after one retry); returns null when there is none to move
 * (unknown, cancelled or of another business). In the same transaction the 24 h reminder is re-timed (see
 * `retimeDayBeforeReminder`); the confirmation is not re-sent for the new time.
 */
export async function moveAppointment(
  db: Database,
  businessId: string,
  appointmentId: string,
  newStartsAt: Date,
  newEndsAt: Date,
  options?: AppointmentWriteOptions,
): Promise<Appointment | null> {
  return withSlotConflicts(async () =>
    db.transaction(async (tx) => {
      const rows = await tx
        .update(appointments)
        .set({ startsAt: newStartsAt, endsAt: newEndsAt })
        .where(
          and(
            eq(appointments.id, appointmentId),
            eq(appointments.businessId, businessId),
            eq(appointments.status, APPOINTMENT_STATUS.BOOKED),
          ),
        )
        .returning();
      const moved = rows[0];
      if (!moved) return null;
      await retimeDayBeforeReminder(tx, moved, writeClock(options), options?.scheduleReminders === true);
      return moved;
    }),
  );
}

export interface ListAppointmentsInput {
  businessId: string;
  /** Inclusive lower bound: appointments ending after it are included. */
  from: Date;
  /** Exclusive upper bound: appointments starting before it are included. */
  to: Date;
}

/** Appointments (any status) overlapping [from, to), ordered by start time. */
export async function listAppointments(db: Database, input: ListAppointmentsInput): Promise<Appointment[]> {
  return db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, input.businessId),
        lt(appointments.startsAt, input.to),
        gt(appointments.endsAt, input.from),
      ),
    )
    .orderBy(asc(appointments.startsAt));
}

/** An appointment together with the customer and service it refers to. */
export interface AppointmentDetail {
  id: string;
  customerId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  status: Appointment["status"];
  customerPhone: string;
  customerName: string | null;
  serviceName: string;
}

/** Like `listAppointments`, with the customer's phone/name and the service name. */
export async function listAppointmentDetails(
  db: Database,
  input: ListAppointmentsInput,
): Promise<AppointmentDetail[]> {
  return db
    .select({
      id: appointments.id,
      customerId: appointments.customerId,
      serviceId: appointments.serviceId,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      status: appointments.status,
      customerPhone: customers.phone,
      customerName: customers.name,
      serviceName: services.name,
    })
    .from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .where(
      and(
        eq(appointments.businessId, input.businessId),
        lt(appointments.startsAt, input.to),
        gt(appointments.endsAt, input.from),
      ),
    )
    .orderBy(asc(appointments.startsAt));
}

/** Sets the IANA timezone the business's opening hours and appointments are read in; throws on an unknown zone. */
export async function setBusinessTimezone(db: Database, businessId: string, timezone: string): Promise<void> {
  // Intl rejects names that are not IANA zones (RangeError), so a bad value never reaches the database.
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  await db.update(businesses).set({ timezone }).where(eq(businesses.id, businessId));
}

/** Deletes a business together with all its agenda data (appointments first); for cleanup and tests. */
export async function removeBusinessWithAgenda(db: Database, businessId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(whatsappProcessedMessages).where(eq(whatsappProcessedMessages.businessId, businessId));
    await tx.delete(whatsappChannels).where(eq(whatsappChannels.businessId, businessId));
    await tx.delete(appointmentReminders).where(eq(appointmentReminders.businessId, businessId));
    await tx.delete(appointments).where(eq(appointments.businessId, businessId));
    await tx.delete(openingHours).where(eq(openingHours.businessId, businessId));
    await tx.delete(services).where(eq(services.businessId, businessId));
    await tx.delete(customers).where(eq(customers.businessId, businessId));
    await tx.delete(businesses).where(eq(businesses.id, businessId));
  });
}
