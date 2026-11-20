import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  cancelUpcomingAppointmentForPhone,
  claimWhatsappMessage,
  completeWhatsappMessage,
  createAppointment,
  createDb,
  createService,
  ensureBusiness,
  findBookedAppointmentForPhoneAt,
  findBusinessByName,
  findUpcomingAppointmentForPhone,
  findWhatsappChannel,
  getWhatsappMessageMarker,
  linkWhatsappChannel,
  listUpcomingAppointmentsForPhone,
  releaseWhatsappMessage,
  removeBusinessIfUnreferenced,
  removeBusinessWithAgenda,
  setBusinessTimezone,
  sql,
  upsertCustomer,
} from "@gestion/db";
import { databaseUrl } from "./support/env.ts";

const NOW = new Date("2031-03-10T13:00:00Z");

describe("WhatsApp data layer", () => {
  const database = createDb(databaseUrl);
  const { db } = database;
  const businessIds: string[] = [];

  async function newBusiness(): Promise<string> {
    const business = await ensureBusiness(db, `WhatsApp db ${randomUUID()}`);
    businessIds.push(business.id);
    return business.id;
  }

  const phoneNumberId = () => `2${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;

  afterAll(async () => {
    for (const id of businessIds) await removeBusinessWithAgenda(db, id);
    await database.close();
  });

  describe("channels", () => {
    it("links a phone number id to a business, reports a repeat, and refuses another business", async () => {
      const [first, second] = [await newBusiness(), await newBusiness()];
      const id = phoneNumberId();

      expect(await findWhatsappChannel(db, id)).toBeNull();
      expect(await linkWhatsappChannel(db, first, id)).toBe("linked");
      expect(await linkWhatsappChannel(db, first, id)).toBe("already_linked");
      expect(await linkWhatsappChannel(db, second, id)).toBe("other_business");

      const channel = await findWhatsappChannel(db, id);
      expect(channel).toMatchObject({ businessId: first, timezone: "America/Bogota" });
      expect(channel?.businessName).toContain("WhatsApp db");
    });

    it("returns the business timezone, which can be changed", async () => {
      const business = await newBusiness();
      const id = phoneNumberId();
      await linkWhatsappChannel(db, business, id);

      await setBusinessTimezone(db, business, "America/New_York");

      expect((await findWhatsappChannel(db, id))?.timezone).toBe("America/New_York");
      await expect(setBusinessTimezone(db, business, "Mars/Olympus")).rejects.toThrow();
    });

    it("protects a business with channels or processed messages from removeBusinessIfUnreferenced, and removeBusinessWithAgenda deletes them", async () => {
      const name = `WhatsApp db ${randomUUID()}`;
      const business = await ensureBusiness(db, name);
      businessIds.push(business.id);
      await linkWhatsappChannel(db, business.id, phoneNumberId());
      await claimWhatsappMessage(db, { wamid: `wamid.${randomUUID()}`, businessId: business.id });

      await removeBusinessIfUnreferenced(db, business.id);
      expect(await findBusinessByName(db, name)).not.toBeNull();

      await removeBusinessWithAgenda(db, business.id);
      expect(await findBusinessByName(db, name)).toBeNull();
    });
  });

  describe("processed messages", () => {
    it("is claimed once per wamid, even under concurrency, and can be released", async () => {
      const business = await newBusiness();
      const wamid = `wamid.${randomUUID()}`;

      const claims = await Promise.all(Array.from({ length: 12 }, () => claimWhatsappMessage(db, { wamid, businessId: business })));

      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await claimWhatsappMessage(db, { wamid, businessId: business })).toBe(false);
      await releaseWhatsappMessage(db, wamid);
      expect(await claimWhatsappMessage(db, { wamid, businessId: business })).toBe(true);
    });

    it("stores an uncompleted marker, and completing it records the time", async () => {
      const business = await newBusiness();
      const wamid = `wamid.${randomUUID()}`;

      expect(await getWhatsappMessageMarker(db, wamid)).toBeNull();
      await claimWhatsappMessage(db, { wamid, businessId: business });
      expect(await getWhatsappMessageMarker(db, wamid)).toMatchObject({ businessId: business, completedAt: null });

      await completeWhatsappMessage(db, wamid);

      const marker = await getWhatsappMessageMarker(db, wamid);
      expect(marker?.completedAt).toBeInstanceOf(Date);
      expect(marker?.completedAt?.getTime()).toBeGreaterThanOrEqual(marker?.receivedAt.getTime() ?? Infinity);
    });

    it("refuses a claim inside the lease (default 2 minutes) and takes an expired uncompleted marker over once", async () => {
      const business = await newBusiness();
      const wamid = `wamid.${randomUUID()}`;
      await claimWhatsappMessage(db, { wamid, businessId: business });
      const claimedAt = (await getWhatsappMessageMarker(db, wamid))?.receivedAt.getTime() ?? 0;

      expect(await claimWhatsappMessage(db, { wamid, businessId: business })).toBe(false);
      expect(await claimWhatsappMessage(db, { wamid, businessId: business }, { leaseMs: 60_000 })).toBe(false);
      expect((await getWhatsappMessageMarker(db, wamid))?.receivedAt.getTime()).toBe(claimedAt);

      expect(await claimWhatsappMessage(db, { wamid, businessId: business }, { leaseMs: 0 })).toBe(true);
      const takenOver = await getWhatsappMessageMarker(db, wamid);
      expect(takenOver?.receivedAt.getTime()).toBeGreaterThan(claimedAt);
      expect(takenOver?.completedAt).toBeNull();
      expect(await claimWhatsappMessage(db, { wamid, businessId: business })).toBe(false);
    });

    /** Makes an uncompleted marker look as if it was claimed an hour ago, so no real waiting (or stall) is involved. */
    async function ageMarker(wamid: string): Promise<void> {
      await db.execute(sql`update whatsapp_processed_messages set received_at = now() - interval '1 hour' where wamid = ${wamid}`);
    }

    it("honours an injected lease: refused inside it, taken over once the marker is older than it", async () => {
      const business = await newBusiness();
      const wamid = `wamid.${randomUUID()}`;
      await claimWhatsappMessage(db, { wamid, businessId: business });
      const lease = { leaseMs: 10 * 60_000 };

      expect(await claimWhatsappMessage(db, { wamid, businessId: business }, lease)).toBe(false);
      await ageMarker(wamid);
      expect(await claimWhatsappMessage(db, { wamid, businessId: business }, { leaseMs: 2 * 60 * 60_000 })).toBe(false);
      expect(await claimWhatsappMessage(db, { wamid, businessId: business }, lease)).toBe(true);
      expect(await claimWhatsappMessage(db, { wamid, businessId: business }, lease)).toBe(false);
    });

    it("never takes over a completed marker", async () => {
      const business = await newBusiness();
      const wamid = `wamid.${randomUUID()}`;
      await claimWhatsappMessage(db, { wamid, businessId: business });
      await completeWhatsappMessage(db, wamid);

      expect(await claimWhatsappMessage(db, { wamid, businessId: business }, { leaseMs: 0 })).toBe(false);
      expect(await claimWhatsappMessage(db, { wamid, businessId: business })).toBe(false);
    });

    it("lets exactly one of 20 concurrent claims take an expired marker over", async () => {
      const business = await newBusiness();
      const wamid = `wamid.${randomUUID()}`;
      await claimWhatsappMessage(db, { wamid, businessId: business });
      await ageMarker(wamid);

      // The lease (10 minutes) is far longer than any stall: the only claim that can win is the first to run.
      const claims = await Promise.all(
        Array.from({ length: 20 }, () => claimWhatsappMessage(db, { wamid, businessId: business }, { leaseMs: 10 * 60_000 })),
      );

      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it("completing an unknown message is a no-op", async () => {
      await completeWhatsappMessage(db, `wamid.${randomUUID()}`);
    });
  });

  describe("appointments of one phone", () => {
    async function setup() {
      const business = await newBusiness();
      const service = await createService(db, { businessId: business, name: "Corte", durationMinutes: 30 });
      const mine = await upsertCustomer(db, { businessId: business, phone: "573001110000" });
      const other = await upsertCustomer(db, { businessId: business, phone: "573002220000" });
      const book = (customerId: string, startsAt: string, status?: "cancelled") =>
        createAppointment(db, {
          businessId: business,
          customerId,
          serviceId: service.id,
          startsAt: new Date(startsAt),
          endsAt: new Date(Date.parse(startsAt) + 30 * 60_000),
        }).then(async (row) => {
          if (status) await cancelUpcomingAppointmentForPhone(db, { businessId: business, phone: "573001110000", appointmentId: row.id, from: new Date("2000-01-01") });
          return row;
        });
      return { business, mine, other, book };
    }

    it("lists only booked, upcoming appointments of that phone in order, limited", async () => {
      const { business, mine, other, book } = await setup();
      const late = await book(mine.id, "2031-03-12T14:00:00Z");
      const soon = await book(mine.id, "2031-03-11T14:00:00Z");
      await book(mine.id, "2031-03-10T12:00:00Z"); // past
      await book(mine.id, "2031-03-13T14:00:00Z", "cancelled");
      await book(other.id, "2031-03-14T14:00:00Z");

      const listed = await listUpcomingAppointmentsForPhone(db, { businessId: business, phone: "573001110000", from: NOW, limit: 10 });
      const limited = await listUpcomingAppointmentsForPhone(db, { businessId: business, phone: "573001110000", from: NOW, limit: 1 });
      const none = await listUpcomingAppointmentsForPhone(db, { businessId: business, phone: "573009999999", from: NOW, limit: 10 });

      expect(listed.map((row) => row.id)).toEqual([soon.id, late.id]);
      expect(listed[0]).toMatchObject({ serviceName: "Corte", customerPhone: "573001110000", status: "booked" });
      expect(limited.map((row) => row.id)).toEqual([soon.id]);
      expect(none).toEqual([]);
    });

    it("pages with an offset, in a stable order", async () => {
      const { business, mine, book } = await setup();
      const rows = [];
      for (let n = 0; n < 5; n++) rows.push(await book(mine.id, `2031-03-1${1 + n}T14:00:00Z`));
      const input = { businessId: business, phone: "573001110000", from: NOW };

      const first = await listUpcomingAppointmentsForPhone(db, { ...input, limit: 2 });
      const second = await listUpcomingAppointmentsForPhone(db, { ...input, limit: 2, offset: 2 });
      const past = await listUpcomingAppointmentsForPhone(db, { ...input, limit: 2, offset: 50 });

      expect([...first, ...second].map((row) => row.id)).toEqual(rows.slice(0, 4).map((row) => row.id));
      expect(past).toEqual([]);
    });

    it("finds the booked appointment of a phone for the same service and start only", async () => {
      const { business, mine, other, book } = await setup();
      const booked = await book(mine.id, "2031-03-11T14:00:00Z");
      const [service] = await db.query.services.findMany({ where: (table, { eq }) => eq(table.businessId, business) });
      const base = { businessId: business, phone: "573001110000", serviceId: service?.id ?? "", startsAt: new Date("2031-03-11T14:00:00Z") };

      expect((await findBookedAppointmentForPhoneAt(db, base))?.id).toBe(booked.id);
      expect(await findBookedAppointmentForPhoneAt(db, { ...base, phone: "573002220000" })).toBeNull();
      expect(await findBookedAppointmentForPhoneAt(db, { ...base, startsAt: new Date("2031-03-11T14:30:00Z") })).toBeNull();
      expect(await findBookedAppointmentForPhoneAt(db, { ...base, serviceId: randomUUID() })).toBeNull();
      await cancelUpcomingAppointmentForPhone(db, { businessId: business, phone: "573001110000", appointmentId: booked.id, from: NOW });
      expect(await findBookedAppointmentForPhoneAt(db, base)).toBeNull();
      expect(other.id).not.toBe(mine.id);
    });

    it("finds and cancels an appointment only for its own phone, business and while upcoming and booked", async () => {
      const { business, mine, other, book } = await setup();
      const appointment = await book(mine.id, "2031-03-11T14:00:00Z");
      const past = await book(mine.id, "2031-03-10T12:00:00Z");
      const base = { businessId: business, appointmentId: appointment.id, from: NOW };

      expect(await findUpcomingAppointmentForPhone(db, { ...base, phone: "573002220000" })).toBeNull();
      expect(await cancelUpcomingAppointmentForPhone(db, { ...base, phone: "573002220000" })).toBeNull();
      expect(await cancelUpcomingAppointmentForPhone(db, { ...base, businessId: await newBusiness(), phone: "573001110000" })).toBeNull();
      expect(await findUpcomingAppointmentForPhone(db, { ...base, appointmentId: past.id, phone: "573001110000" })).toBeNull();
      expect(await cancelUpcomingAppointmentForPhone(db, { ...base, appointmentId: past.id, phone: "573001110000" })).toBeNull();
      expect(await findUpcomingAppointmentForPhone(db, { ...base, phone: "573001110000" })).toMatchObject({ id: appointment.id });

      const cancelled = await cancelUpcomingAppointmentForPhone(db, { ...base, phone: "573001110000" });
      const again = await cancelUpcomingAppointmentForPhone(db, { ...base, phone: "573001110000" });

      expect(cancelled).toMatchObject({ id: appointment.id, status: "cancelled" });
      expect(again).toBeNull();
      expect(other.id).not.toBe(mine.id);
    });
  });
});
