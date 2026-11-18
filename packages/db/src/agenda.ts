import { and, asc, eq, gt, lt } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  APPOINTMENT_STATUS,
  appointments,
  businesses,
  customers,
  openingHours,
  services,
  type Appointment,
  type Customer,
  type OpeningHour,
  type Service,
} from "./schema.ts";

/** Postgres SQLSTATE for exclusion_violation. */
const EXCLUSION_VIOLATION = "23P01";

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

export interface CreateAppointmentInput {
  businessId: string;
  customerId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
}

/** Books a slot; throws `SlotTakenError` when it overlaps a booked appointment of the business. */
export async function createAppointment(db: Database, input: CreateAppointmentInput): Promise<Appointment> {
  try {
    const rows = await db.insert(appointments).values(input).returning();
    return firstRow(rows, "appointment");
  } catch (error) {
    if (postgresErrorCode(error) === EXCLUSION_VIOLATION) throw new SlotTakenError({ cause: error });
    throw error;
  }
}

/** Cancels a booked appointment of the business, freeing its slot; null when there is none to cancel. */
export async function cancelAppointment(
  db: Database,
  businessId: string,
  appointmentId: string,
): Promise<Appointment | null> {
  const rows = await db
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
  return rows[0] ?? null;
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

/** Deletes a business together with all its agenda data (appointments first); for cleanup and tests. */
export async function removeBusinessWithAgenda(db: Database, businessId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(appointments).where(eq(appointments.businessId, businessId));
    await tx.delete(openingHours).where(eq(openingHours.businessId, businessId));
    await tx.delete(services).where(eq(services.businessId, businessId));
    await tx.delete(customers).where(eq(customers.businessId, businessId));
    await tx.delete(businesses).where(eq(businesses.id, businessId));
  });
}
