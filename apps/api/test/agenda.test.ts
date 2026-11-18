import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelAppointment,
  createAppointment,
  createDb,
  createService,
  ensureBusiness,
  listAppointments,
  removeBusinessIfUnreferenced,
  removeBusinessWithAgenda,
  schema,
  setOpeningHours,
  SlotTakenError,
  upsertCustomer,
} from "@gestion/db";
import { databaseUrl } from "./support/env.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2031-03-10T14:00:00.000Z");

function slot(startMinute: number, endMinute: number) {
  return { startsAt: new Date(BASE + startMinute * MINUTE), endsAt: new Date(BASE + endMinute * MINUTE) };
}

function range(startMinute: number, endMinute: number) {
  const { startsAt, endsAt } = slot(startMinute, endMinute);
  return { from: startsAt, to: endsAt };
}

/** Postgres SQLSTATE of an error, looking through drizzle's wrapper. */
async function sqlState(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    let current: unknown = error;
    while (typeof current === "object" && current !== null) {
      if ("code" in current && typeof current.code === "string") return current.code;
      current = "cause" in current ? current.cause : undefined;
    }
    return "no-code";
  }
  return undefined;
}

describe("agenda data layer", () => {
  const database = createDb(databaseUrl);
  const db = database.db;
  const businessIds: string[] = [];

  async function newBusiness() {
    const { id } = await ensureBusiness(db, `Agenda ${randomUUID()}`);
    businessIds.push(id);
    return id;
  }

  /** A business with one customer and one service, ready to book. */
  async function newAgenda() {
    const businessId = await newBusiness();
    const customer = await upsertCustomer(db, { businessId, phone: `+57${Date.now()}${businessIds.length}`, name: "Ana" });
    const service = await createService(db, { businessId, name: "Corte", durationMinutes: 30 });
    return { businessId, customerId: customer.id, serviceId: service.id };
  }

  afterAll(async () => {
    for (const businessId of businessIds) await removeBusinessWithAgenda(db, businessId);
    await database.close();
  });

  describe("when a slot is already booked", () => {
    let agenda: Awaited<ReturnType<typeof newAgenda>>;
    let first: schema.Appointment;

    beforeAll(async () => {
      agenda = await newAgenda();
      first = await createAppointment(db, { ...agenda, ...slot(0, 30) });
    });

    it("rejects an identical booking with SlotTakenError and leaves the first unchanged", async () => {
      // When
      const second = createAppointment(db, { ...agenda, ...slot(0, 30) });

      // Then
      await expect(second).rejects.toBeInstanceOf(SlotTakenError);
      const rows = await listAppointments(db, { businessId: agenda.businessId, ...range(-60, 120) });
      expect(rows).toEqual([first]);
      expect(first.status).toBe("booked");
    });

    it("rejects a partially overlapping booking", async () => {
      await expect(createAppointment(db, { ...agenda, ...slot(15, 45) })).rejects.toBeInstanceOf(SlotTakenError);
      await expect(createAppointment(db, { ...agenda, ...slot(-15, 15) })).rejects.toBeInstanceOf(SlotTakenError);
    });

    it("rejects a booking fully contained in it", async () => {
      await expect(createAppointment(db, { ...agenda, ...slot(10, 20) })).rejects.toBeInstanceOf(SlotTakenError);
    });

    it("rejects a booking that fully contains it", async () => {
      await expect(createAppointment(db, { ...agenda, ...slot(-10, 40) })).rejects.toBeInstanceOf(SlotTakenError);
    });

    it("accepts back-to-back bookings on both sides (end equals next start)", async () => {
      const after = await createAppointment(db, { ...agenda, ...slot(30, 60) });
      const before = await createAppointment(db, { ...agenda, ...slot(-30, 0) });

      const rows = await listAppointments(db, { businessId: agenda.businessId, ...range(-60, 120) });
      expect(rows.map((row) => row.id)).toEqual([before.id, first.id, after.id]);
    });
  });

  describe("when an appointment is cancelled", () => {
    it("frees the slot for a new booking and keeps the cancelled row", async () => {
      // Given
      const agenda = await newAgenda();
      const booked = await createAppointment(db, { ...agenda, ...slot(0, 30) });

      // When
      const cancelled = await cancelAppointment(db, agenda.businessId, booked.id);
      const rebooked = await createAppointment(db, { ...agenda, ...slot(0, 30) });

      // Then
      expect(cancelled?.status).toBe("cancelled");
      expect(rebooked.id).not.toBe(booked.id);
      const rows = await listAppointments(db, { businessId: agenda.businessId, ...range(0, 30) });
      expect(rows.map((row) => [row.id, row.status]).sort()).toEqual(
        [
          [booked.id, "cancelled"],
          [rebooked.id, "booked"],
        ].sort(),
      );
    });

    it("returns null when cancelling twice or from another business", async () => {
      const agenda = await newAgenda();
      const otherBusinessId = await newBusiness();
      const booked = await createAppointment(db, { ...agenda, ...slot(0, 30) });

      expect(await cancelAppointment(db, otherBusinessId, booked.id)).toBeNull();
      expect((await cancelAppointment(db, agenda.businessId, booked.id))?.status).toBe("cancelled");
      expect(await cancelAppointment(db, agenda.businessId, booked.id)).toBeNull();
    });
  });

  describe("when two businesses book the same time range", () => {
    it("does not conflict", async () => {
      const a = await newAgenda();
      const b = await newAgenda();

      const first = await createAppointment(db, { ...a, ...slot(0, 30) });
      const second = await createAppointment(db, { ...b, ...slot(0, 30) });

      expect(first.businessId).toBe(a.businessId);
      expect(second.businessId).toBe(b.businessId);
      expect(await listAppointments(db, { businessId: a.businessId, ...range(0, 30) })).toHaveLength(1);
    });
  });

  describe("when many bookings race for the same slot", () => {
    it("lets exactly one win and rejects the rest with SlotTakenError", async () => {
      const agenda = await newAgenda();
      const attempts = 10;

      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () => createAppointment(db, { ...agenda, ...slot(0, 30) })),
      );

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(attempts - 1);
      for (const result of rejected) expect(result.reason).toBeInstanceOf(SlotTakenError);
      const rows = await db.query.appointments.findMany({
        where: (table, { eq }) => eq(table.businessId, agenda.businessId),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("booked");
    });
  });

  describe("when an appointment references another business's customer or service", () => {
    it("rejects a customer of another business and creates no row", async () => {
      const mine = await newAgenda();
      const other = await newAgenda();

      const run = createAppointment(db, { ...mine, customerId: other.customerId, ...slot(0, 30) });

      expect(await sqlState(run)).toBe("23503");
      expect(await listAppointments(db, { businessId: mine.businessId, ...range(-60, 120) })).toEqual([]);
      expect(await listAppointments(db, { businessId: other.businessId, ...range(-60, 120) })).toEqual([]);
    });

    it("rejects a service of another business and creates no row", async () => {
      const mine = await newAgenda();
      const other = await newAgenda();

      const run = createAppointment(db, { ...mine, serviceId: other.serviceId, ...slot(0, 30) });

      expect(await sqlState(run)).toBe("23503");
      expect(await listAppointments(db, { businessId: mine.businessId, ...range(-60, 120) })).toEqual([]);
      expect(await listAppointments(db, { businessId: other.businessId, ...range(-60, 120) })).toEqual([]);
    });
  });

  describe("when an existing appointment is changed in place", () => {
    it("rejects moving it into an occupied range as an overlap and leaves it unchanged", async () => {
      const agenda = await newAgenda();
      await createAppointment(db, { ...agenda, ...slot(0, 30) });
      const movable = await createAppointment(db, { ...agenda, ...slot(60, 90) });
      const target = slot(15, 45);

      const run = db.$client`update appointments set starts_at = ${target.startsAt.toISOString()}, ends_at = ${target.endsAt.toISOString()} where id = ${movable.id}`;

      expect(await sqlState(run)).toBe("23P01");
      const rows = await listAppointments(db, { businessId: agenda.businessId, ...range(60, 90) });
      expect(rows).toEqual([movable]);
    });

    it("rejects un-cancelling into an occupied slot as an overlap and keeps it cancelled", async () => {
      const agenda = await newAgenda();
      const cancelledOne = await createAppointment(db, { ...agenda, ...slot(0, 30) });
      await cancelAppointment(db, agenda.businessId, cancelledOne.id);
      await createAppointment(db, { ...agenda, ...slot(0, 30) });

      const run = db.$client`update appointments set status = 'booked' where id = ${cancelledOne.id}`;

      expect(await sqlState(run)).toBe("23P01");
      const rows = await db.query.appointments.findMany({ where: (table, { eq }) => eq(table.id, cancelledOne.id) });
      expect(rows.map((row) => row.status)).toEqual(["cancelled"]);
    });
  });

  describe("when data violates a CHECK constraint", () => {
    it("rejects an appointment that ends before or when it starts", async () => {
      const agenda = await newAgenda();

      expect(await sqlState(createAppointment(db, { ...agenda, ...slot(30, 30) }))).toBe("23514");
      expect(await sqlState(createAppointment(db, { ...agenda, ...slot(30, 0) }))).toBe("23514");
      expect(await listAppointments(db, { businessId: agenda.businessId, ...range(-60, 120) })).toEqual([]);
    });

    it("rejects a service with a non-positive duration", async () => {
      const businessId = await newBusiness();

      expect(await sqlState(createService(db, { businessId, name: "Cero", durationMinutes: 0 }))).toBe("23514");
      expect(await sqlState(createService(db, { businessId, name: "Negativo", durationMinutes: -5 }))).toBe("23514");
      expect(await db.query.services.findMany({ where: (table, { eq }) => eq(table.businessId, businessId) })).toEqual([]);
    });

    it("rejects opening hours with weekday 7 or closing at or before opening", async () => {
      const businessId = await newBusiness();

      expect(await sqlState(setOpeningHours(db, businessId, [{ weekday: 7, opensAt: "09:00", closesAt: "18:00" }]))).toBe("23514");
      expect(await sqlState(setOpeningHours(db, businessId, [{ weekday: 1, opensAt: "18:00", closesAt: "09:00" }]))).toBe("23514");
      expect(await sqlState(setOpeningHours(db, businessId, [{ weekday: 1, opensAt: "09:00", closesAt: "09:00" }]))).toBe("23514");
      expect(await db.query.openingHours.findMany({ where: (table, { eq }) => eq(table.businessId, businessId) })).toEqual([]);
    });
  });

  describe("opening hours", () => {
    it("allows several ranges per weekday and replaces the previous schedule", async () => {
      const businessId = await newBusiness();

      await setOpeningHours(db, businessId, [
        { weekday: 1, opensAt: "09:00", closesAt: "13:00" },
        { weekday: 1, opensAt: "14:00", closesAt: "18:00" },
      ]);
      const replaced = await setOpeningHours(db, businessId, [{ weekday: 0, opensAt: "10:00", closesAt: "12:00" }]);

      const rows = await db.query.openingHours.findMany({ where: (table, { eq }) => eq(table.businessId, businessId) });
      expect(rows.map((row) => row.id)).toEqual(replaced.map((row) => row.id));
      expect(rows.map((row) => [row.weekday, row.opensAt, row.closesAt])).toEqual([[0, "10:00:00", "12:00:00"]]);
    });
  });

  describe("customers", () => {
    it("upserts by business and phone without duplicating", async () => {
      const businessId = await newBusiness();
      const otherBusinessId = await newBusiness();
      const phone = `+5730${Date.now()}`;

      const first = await upsertCustomer(db, { businessId, phone, name: "Ana" });
      const again = await upsertCustomer(db, { businessId, phone });
      const renamed = await upsertCustomer(db, { businessId, phone, name: "Ana María" });
      const other = await upsertCustomer(db, { businessId: otherBusinessId, phone, name: "Otra" });

      expect(again.id).toBe(first.id);
      expect(again.name).toBe("Ana");
      expect(renamed.id).toBe(first.id);
      expect(renamed.name).toBe("Ana María");
      expect(other.id).not.toBe(first.id);
      const rows = await db.query.customers.findMany({ where: (table, { eq }) => eq(table.businessId, businessId) });
      expect(rows).toHaveLength(1);
    });
  });

  describe("removeBusinessIfUnreferenced", () => {
    async function exists(businessId: string): Promise<boolean> {
      const rows = await db.query.businesses.findMany({ where: (table, { eq }) => eq(table.id, businessId) });
      return rows.length > 0;
    }

    it("deletes a business nothing references", async () => {
      const businessId = await newBusiness();

      await removeBusinessIfUnreferenced(db, businessId);

      expect(await exists(businessId)).toBe(false);
    });

    it("keeps a business that has a service", async () => {
      const businessId = await newBusiness();
      await createService(db, { businessId, name: "Corte", durationMinutes: 30 });

      await removeBusinessIfUnreferenced(db, businessId);

      expect(await exists(businessId)).toBe(true);
    });

    it("keeps a business that has a customer", async () => {
      const businessId = await newBusiness();
      await upsertCustomer(db, { businessId, phone: `+5731${Date.now()}` });

      await removeBusinessIfUnreferenced(db, businessId);

      expect(await exists(businessId)).toBe(true);
    });

    it("keeps a business that only has opening hours", async () => {
      const businessId = await newBusiness();
      await setOpeningHours(db, businessId, [{ weekday: 2, opensAt: "09:00", closesAt: "17:00" }]);

      await removeBusinessIfUnreferenced(db, businessId);

      expect(await exists(businessId)).toBe(true);
    });
  });
});
