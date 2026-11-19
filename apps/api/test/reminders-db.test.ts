import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  SlotTakenError,
  cancelAppointment,
  claimDueReminders,
  createAppointment,
  createDb,
  createService,
  deferReminder,
  ensureBusiness,
  listRemindersForAppointment,
  listRemindersForBusiness,
  removeBusinessIfUnreferenced,
  removeBusinessWithAgenda,
  schema,
  upsertCustomer,
} from "@gestion/db";
import { databaseUrl } from "./support/env.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date("2031-03-10T13:00:00.000Z");

function codeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

describe("appointment_reminders data layer", () => {
  const database = createDb(databaseUrl);
  const { db } = database;
  const businessIds: string[] = [];

  afterAll(async () => {
    for (const id of businessIds) await removeBusinessWithAgenda(db, id);
    await database.close();
  });

  async function newBusiness() {
    const business = await ensureBusiness(db, `Reminders db ${randomUUID()}`);
    businessIds.push(business.id);
    const service = await createService(db, { businessId: business.id, name: "Corte", durationMinutes: 30 });
    const customer = await upsertCustomer(db, { businessId: business.id, phone: `57300${Math.floor(Math.random() * 9_000_000 + 1_000_000)}` });
    return { businessId: business.id, serviceId: service.id, customerId: customer.id };
  }

  async function book(
    business: { businessId: string; serviceId: string; customerId: string },
    startsAt: Date,
    options?: Parameters<typeof createAppointment>[2],
  ) {
    return createAppointment(
      db,
      {
        businessId: business.businessId,
        customerId: business.customerId,
        serviceId: business.serviceId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * MINUTE),
      },
      options,
    );
  }

  describe("createAppointment", () => {
    it("schedules nothing unless asked to", async () => {
      const business = await newBusiness();

      const appointment = await book(business, new Date(NOW.getTime() + 3 * DAY));

      expect(await listRemindersForAppointment(db, appointment.id)).toEqual([]);
    });

    it("schedules a confirmation due at the injected clock and a 24 h reminder when asked to", async () => {
      const business = await newBusiness();

      const appointment = await book(business, new Date(NOW.getTime() + 3 * DAY), { scheduleReminders: true, now: () => NOW });

      const rows = await listRemindersForAppointment(db, appointment.id);
      expect(rows.map((row) => [row.kind, row.status, row.dueAt.toISOString(), row.attempts, row.businessId])).toEqual([
        ["confirmation", "pending", NOW.toISOString(), 0, business.businessId],
        ["reminder_24h", "pending", new Date(NOW.getTime() + 2 * DAY).toISOString(), 0, business.businessId],
      ]);
    });

    it("stores no reminder and no appointment when the slot is taken (same transaction)", async () => {
      const business = await newBusiness();
      const start = new Date(NOW.getTime() + 3 * DAY);
      await book(business, start, { scheduleReminders: true, now: () => NOW });

      await expect(book(business, start, { scheduleReminders: true, now: () => NOW })).rejects.toBeInstanceOf(SlotTakenError);

      expect(await listRemindersForBusiness(db, business.businessId)).toHaveLength(2);
    });
  });

  describe("cancelAppointment", () => {
    it("does not touch the reminders of an appointment of another business", async () => {
      const owner = await newBusiness();
      const intruder = await newBusiness();
      const appointment = await book(owner, new Date(NOW.getTime() + 3 * DAY), { scheduleReminders: true, now: () => NOW });

      const result = await cancelAppointment(db, intruder.businessId, appointment.id);

      expect(result).toBeNull();
      expect((await listRemindersForAppointment(db, appointment.id)).map((row) => row.status)).toEqual(["pending", "pending"]);
    });
  });

  describe("constraints", () => {
    async function reminderFor(business: { businessId: string }, appointmentId: string, overrides: Record<string, unknown> = {}) {
      return db
        .insert(schema.appointmentReminders)
        .values({
          businessId: business.businessId,
          appointmentId,
          kind: "confirmation",
          dueAt: NOW,
          ...overrides,
        } as typeof schema.appointmentReminders.$inferInsert)
        .returning();
    }

    it("refuses a reminder that pairs an appointment with another business (composite foreign key)", async () => {
      const owner = await newBusiness();
      const other = await newBusiness();
      const appointment = await book(owner, new Date(NOW.getTime() + 3 * DAY));

      const failure = await reminderFor(other, appointment.id).catch((error: unknown) => error);

      expect(codeOf(failure)).toBe("23503");
    });

    it("refuses a second reminder of the same kind for one appointment", async () => {
      const business = await newBusiness();
      const appointment = await book(business, new Date(NOW.getTime() + 3 * DAY));
      await reminderFor(business, appointment.id);

      const failure = await reminderFor(business, appointment.id).catch((error: unknown) => error);

      expect(codeOf(failure)).toBe("23505");
    });

    it.each([
      ["kind", { kind: "newsletter" }],
      ["status", { status: "queued" }],
      ["attempts", { attempts: -1 }],
    ])("refuses an invalid %s", async (_name, overrides) => {
      const business = await newBusiness();
      const appointment = await book(business, new Date(NOW.getTime() + 3 * DAY));

      const failure = await reminderFor(business, appointment.id, overrides).catch((error: unknown) => error);

      expect(codeOf(failure)).toBe("23514");
    });
  });

  describe("business removal", () => {
    it("removeBusinessIfUnreferenced keeps a business that has reminders", async () => {
      const business = await newBusiness();
      await book(business, new Date(NOW.getTime() + 3 * DAY), { scheduleReminders: true, now: () => NOW });

      await removeBusinessIfUnreferenced(db, business.businessId);

      expect(await listRemindersForBusiness(db, business.businessId)).toHaveLength(2);
    });

    it("removeBusinessWithAgenda removes the reminders with the business", async () => {
      const business = await newBusiness();
      await book(business, new Date(NOW.getTime() + 3 * DAY), { scheduleReminders: true, now: () => NOW });

      await removeBusinessWithAgenda(db, business.businessId);

      expect(await listRemindersForBusiness(db, business.businessId)).toEqual([]);
    });
  });

  describe("claimDueReminders", () => {
    it("hands every due reminder to exactly one of 20 concurrent claimers", async () => {
      // Given - 12 due reminders of one business
      const business = await newBusiness();
      for (let index = 0; index < 6; index++) {
        await book(business, new Date(NOW.getTime() + (3 + index) * DAY), { scheduleReminders: true, now: () => NOW });
      }

      // When
      const claims = await Promise.all(
        Array.from({ length: 20 }, () =>
          claimDueReminders(db, { now: new Date(NOW.getTime() + 30 * DAY), leaseMs: 5 * MINUTE, limit: 3, businessIds: [business.businessId] }),
        ),
      );

      // Then
      const ids = claims.flat().map((claim) => claim.id);
      expect(ids).toHaveLength(12);
      expect(new Set(ids).size).toBe(12);
      for (const claim of claims.flat()) expect(claim.attempts).toBe(1);
    });

    it("does not claim reminders before they are due, and moves the claimed ones to sending", async () => {
      const business = await newBusiness();
      const appointment = await book(business, new Date(NOW.getTime() + 3 * DAY), { scheduleReminders: true, now: () => NOW });

      const early = await claimDueReminders(db, { now: new Date(NOW.getTime() - 1), leaseMs: 5 * MINUTE, limit: 10, businessIds: [business.businessId] });
      const due = await claimDueReminders(db, { now: NOW, leaseMs: 5 * MINUTE, limit: 10, businessIds: [business.businessId] });

      expect(early).toEqual([]);
      expect(due.map((claim) => claim.kind)).toEqual(["confirmation"]);
      expect((await listRemindersForAppointment(db, appointment.id)).map((row) => row.status)).toEqual(["sending", "pending"]);
    });

    it("never claims another business's reminders when scoped, and takes nothing when the scope is empty", async () => {
      const mine = await newBusiness();
      const theirs = await newBusiness();
      await book(theirs, new Date(NOW.getTime() + 3 * DAY), { scheduleReminders: true, now: () => NOW });

      const scoped = await claimDueReminders(db, { now: NOW, leaseMs: 5 * MINUTE, limit: 10, businessIds: [mine.businessId] });
      const empty = await claimDueReminders(db, { now: NOW, leaseMs: 5 * MINUTE, limit: 10, businessIds: [] });

      expect(scoped).toEqual([]);
      expect(empty).toEqual([]);
      expect((await listRemindersForBusiness(db, theirs.businessId)).map((row) => row.status)).toEqual(["pending", "pending"]);
    });
  });

  describe("deferReminder", () => {
    const lease = 5 * MINUTE;

    it("puts a claimed reminder back to pending with its attempt refunded, keeping it due, and the next claim counts attempt 1", async () => {
      const business = await newBusiness();
      const appointment = await book(business, new Date(NOW.getTime() + 3 * DAY), { scheduleReminders: true, now: () => NOW });
      const [claim] = await claimDueReminders(db, { now: NOW, leaseMs: lease, limit: 1, businessIds: [business.businessId] });
      expect(claim?.attempts).toBe(1);

      const deferred = await deferReminder(db, claim as NonNullable<typeof claim>, "Authentication failed (HTTP 401)");

      expect(deferred).toBe(true);
      const [row] = await listRemindersForAppointment(db, appointment.id);
      expect(row).toMatchObject({ status: "pending", attempts: 0, claimedAt: null, lastError: "Authentication failed (HTTP 401)" });
      expect(row?.dueAt.toISOString()).toBe(NOW.toISOString());
      const [again] = await claimDueReminders(db, { now: NOW, leaseMs: lease, limit: 1, businessIds: [business.businessId] });
      expect(again?.attempts).toBe(1);
    });

    it("refunds only the attempt of the claim: attempts from earlier claims stay counted", async () => {
      const business = await newBusiness();
      const appointment = await book(business, new Date(NOW.getTime() + 3 * DAY), { scheduleReminders: true, now: () => NOW });
      await claimDueReminders(db, { now: NOW, leaseMs: lease, limit: 1, businessIds: [business.businessId] }); // a worker that died
      const later = new Date(NOW.getTime() + 6 * MINUTE);
      const [claim] = await claimDueReminders(db, { now: later, leaseMs: lease, limit: 1, businessIds: [business.businessId] });
      expect(claim?.attempts).toBe(2);

      await deferReminder(db, claim as NonNullable<typeof claim>, "note");

      expect((await listRemindersForAppointment(db, appointment.id))[0]).toMatchObject({ status: "pending", attempts: 1 });
    });

    it("does nothing for a claim that was taken over (stale token) or already settled, and says so", async () => {
      const business = await newBusiness();
      const appointment = await book(business, new Date(NOW.getTime() + 3 * DAY), { scheduleReminders: true, now: () => NOW });
      const [stale] = await claimDueReminders(db, { now: NOW, leaseMs: lease, limit: 1, businessIds: [business.businessId] });
      const [owner] = await claimDueReminders(db, { now: new Date(NOW.getTime() + 6 * MINUTE), leaseMs: lease, limit: 1, businessIds: [business.businessId] });

      const lateDefer = await deferReminder(db, stale as NonNullable<typeof stale>, "stale");

      expect(lateDefer).toBe(false);
      expect((await listRemindersForAppointment(db, appointment.id))[0]).toMatchObject({ status: "sending", attempts: 2, lastError: null });
      expect(await deferReminder(db, owner as NonNullable<typeof owner>, "mine")).toBe(true);
      expect(await deferReminder(db, owner as NonNullable<typeof owner>, "twice")).toBe(false);
    });
  });
});
