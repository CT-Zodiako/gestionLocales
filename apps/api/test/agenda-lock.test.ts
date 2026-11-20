import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  cancelAppointment,
  createAppointment,
  createDb,
  createService,
  ensureBusiness,
  listAppointments,
  lockBusinessAgenda,
  moveAppointment,
  removeBusinessWithAgenda,
  sql,
  SlotTakenError,
  upsertCustomer,
} from "@gestion/db";
import { databaseUrl } from "./support/env.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2031-03-10T14:00:00.000Z");

function slot(startMinute: number, durationMinutes = 30) {
  return {
    startsAt: new Date(BASE + startMinute * MINUTE),
    endsAt: new Date(BASE + (startMinute + durationMinutes) * MINUTE),
  };
}

const TIMEOUT = 30_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves to true when the promise settled within `ms`, false when it is still pending. */
async function settlesWithin(run: Promise<unknown>, ms: number): Promise<boolean> {
  const settled = run.then(
    () => true,
    () => true,
  );
  return Promise.race([settled, sleep(ms).then(() => false)]);
}

describe("agenda write lock (one advisory lock per business)", () => {
  const database = createDb(databaseUrl);
  const db = database.db;
  const businessIds: string[] = [];

  async function newAgenda() {
    const { id: businessId } = await ensureBusiness(db, `Agenda lock ${randomUUID()}`);
    businessIds.push(businessId);
    const customer = await upsertCustomer(db, { businessId, phone: `+57${Date.now()}${businessIds.length}`, name: "Ana" });
    const service = await createService(db, { businessId, name: "Corte", durationMinutes: 30 });
    return { businessId, customerId: customer.id, serviceId: service.id };
  }

  /** Holds the agenda lock of a business inside an open transaction until `release()`. */
  async function holdLock(businessId: string) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const transaction = db.transaction(async (tx) => {
      await lockBusinessAgenda(tx, businessId);
      locked();
      await gate;
    });
    await ready;
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        open();
        await transaction;
      },
    };
  }

  /** Advisory locks of the agenda keyspace on this business: waiting ones (`granted = false`) or granted ones. */
  async function advisoryLocks(businessId: string, granted: boolean): Promise<number> {
    const rows = await db.execute<{ total: string }>(sql`
      select count(*)::text as total
      from pg_locks
      where locktype = 'advisory'
        and granted = ${granted}
        and objsubid = 2
        and database = (select oid from pg_database where datname = current_database())
        and objid::bigint = (hashtext(${businessId}::text)::bigint & 4294967295)
    `);
    return Number(rows[0]?.total ?? "-1");
  }

  /** Polls until a writer of the business is queued behind the lock (positive proof it waits, not just slow). */
  async function waitUntilQueued(businessId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await advisoryLocks(businessId, false)) > 0) return;
      await sleep(25);
    }
    throw new Error("no writer queued behind the agenda lock");
  }

  afterAll(async () => {
    for (const businessId of businessIds) await removeBusinessWithAgenda(db, businessId);
    await database.close();
  });

  describe("while another transaction holds the lock of the business", () => {
    it("makes createAppointment wait, then book once the lock is released", { timeout: TIMEOUT }, async () => {
      const agenda = await newAgenda();
      const holder = await holdLock(agenda.businessId);
      try {
        // When - a booking of a different, free slot of the same business starts
        const booking = createAppointment(db, { ...agenda, ...slot(0) });
        // Then - it is queued behind the lock and has not been stored
        await waitUntilQueued(agenda.businessId);
        expect(await settlesWithin(booking, 300)).toBe(false);
        expect(await listAppointments(db, { businessId: agenda.businessId, from: new Date(BASE - 60 * MINUTE), to: new Date(BASE + 600 * MINUTE) })).toHaveLength(0);
      } finally {
        await holder.release();
      }
      // And - once the lock is released it books
      const created = await createAppointment(db, { ...agenda, ...slot(60) });
      expect(created.status).toBe("booked");
      expect(await listAppointments(db, { businessId: agenda.businessId, from: new Date(BASE - 60 * MINUTE), to: new Date(BASE + 600 * MINUTE) })).toHaveLength(2);
    });

    it("makes createAppointment with reminders wait, and writes the appointment and its reminders after the release", { timeout: TIMEOUT }, async () => {
      const agenda = await newAgenda();
      const holder = await holdLock(agenda.businessId);
      const now = new Date(BASE - 3 * 24 * 60 * MINUTE);
      const booking = createAppointment(db, { ...agenda, ...slot(0) }, { scheduleReminders: true, now: () => now });
      try {
        await waitUntilQueued(agenda.businessId);
        expect(await settlesWithin(booking, 300)).toBe(false);
      } finally {
        await holder.release();
      }

      const created = await booking;

      expect(created.status).toBe("booked");
      const reminders = await db.execute<{ kind: string }>(
        sql`select kind from appointment_reminders where appointment_id = ${created.id} order by kind`,
      );
      expect(reminders.map((row) => row.kind)).toEqual(["confirmation", "reminder_24h"]);
    });

    it("makes moveAppointment wait, then moves once the lock is released", { timeout: TIMEOUT }, async () => {
      const agenda = await newAgenda();
      const booked = await createAppointment(db, { ...agenda, ...slot(0) });
      const target = slot(120);
      const holder = await holdLock(agenda.businessId);
      const move = moveAppointment(db, agenda.businessId, booked.id, target.startsAt, target.endsAt);
      try {
        await waitUntilQueued(agenda.businessId);
        expect(await settlesWithin(move, 300)).toBe(false);
        const rows = await listAppointments(db, { businessId: agenda.businessId, from: new Date(BASE - 60 * MINUTE), to: new Date(BASE + 600 * MINUTE) });
        expect(rows.map((row) => row.startsAt.toISOString())).toEqual([slot(0).startsAt.toISOString()]);
      } finally {
        await holder.release();
      }

      const moved = await move;

      expect(moved?.startsAt.toISOString()).toBe(target.startsAt.toISOString());
    });

    it("does not make cancelAppointment wait: freeing a slot needs no lock", { timeout: TIMEOUT }, async () => {
      const agenda = await newAgenda();
      const booked = await createAppointment(db, { ...agenda, ...slot(0) });
      const holder = await holdLock(agenda.businessId);
      try {
        const cancelled = await cancelAppointment(db, agenda.businessId, booked.id);

        expect(cancelled?.status).toBe("cancelled");
        expect(await advisoryLocks(agenda.businessId, false)).toBe(0);
      } finally {
        await holder.release();
      }
    });

    it("does not delay another business: it books and moves while the first business is locked", { timeout: TIMEOUT }, async () => {
      const locked = await newAgenda();
      const other = await newAgenda();
      const holder = await holdLock(locked.businessId);
      try {
        const created = await createAppointment(db, { ...other, ...slot(0) }, { scheduleReminders: true, now: () => new Date(BASE - 3 * 24 * 60 * MINUTE) });
        const target = slot(90);
        const moved = await moveAppointment(db, other.businessId, created.id, target.startsAt, target.endsAt);
        const plain = await createAppointment(db, { ...other, ...slot(200) });

        expect(created.status).toBe("booked");
        expect(moved?.startsAt.toISOString()).toBe(target.startsAt.toISOString());
        expect(plain.status).toBe("booked");
        expect(await advisoryLocks(other.businessId, false)).toBe(0);
      } finally {
        await holder.release();
      }
    });
  });

  describe("when a write ends", () => {
    it("holds no lock after a booking, a refused booking or a move", { timeout: TIMEOUT }, async () => {
      const agenda = await newAgenda();

      const first = await createAppointment(db, { ...agenda, ...slot(0) });
      expect(await advisoryLocks(agenda.businessId, true)).toBe(0);
      await expect(createAppointment(db, { ...agenda, ...slot(0) })).rejects.toBeInstanceOf(SlotTakenError);
      expect(await advisoryLocks(agenda.businessId, true)).toBe(0);
      await moveAppointment(db, agenda.businessId, first.id, slot(60).startsAt, slot(60).endsAt);
      expect(await advisoryLocks(agenda.businessId, true)).toBe(0);

      // And a later write is not blocked by a lock a failed one left behind
      expect((await createAppointment(db, { ...agenda, ...slot(0) })).status).toBe("booked");
    });
  });

  describe("when many writers race into the same slot of one business", () => {
    it("books exactly once out of 30 concurrent bookings and refuses the other 29 with SlotTakenError", { timeout: 60_000 }, async () => {
      const agenda = await newAgenda();

      const results = await Promise.allSettled(
        Array.from({ length: 30 }, () => createAppointment(db, { ...agenda, ...slot(0) }, { scheduleReminders: true, now: () => new Date(BASE - 3 * 24 * 60 * MINUTE) })),
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((result) => result.status === "rejected");
      expect(rejected).toHaveLength(29);
      for (const result of rejected) expect(result.reason).toBeInstanceOf(SlotTakenError);
      const reminders = await db.execute<{ total: string }>(
        sql`select count(*)::text as total from appointment_reminders where business_id = ${agenda.businessId}`,
      );
      expect(reminders[0]?.total).toBe("2");
    });
  });
});
