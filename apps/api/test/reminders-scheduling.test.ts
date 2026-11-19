import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRemindersForBusiness } from "@gestion/db";
import { createServer } from "../src/server.ts";
import { MINUTE, MONDAY_MORNING, TEMPLATES, createHarness, type Harness, type Tenant } from "./support/whatsapp-harness.ts";
import { DAY, HOUR, createApiTenant, remindersOf, type ApiTenant } from "./support/reminders.ts";
import { APP_SECRET, VERIFY_TOKEN, FakeWhatsAppClient } from "./support/whatsapp.ts";
import { authSecret, authUrl, databaseUrl } from "./support/env.ts";

const NOW = MONDAY_MORNING; // 2031-03-10T13:00:00Z, the harness clock
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const newPhone = () => `57300${randomInt(1_000_000, 9_999_999)}`;

describe("reminder scheduling", () => {
  let harness: Harness;
  let owner: ApiTenant;
  let other: ApiTenant;

  beforeAll(async () => {
    harness = await createHarness({ reminders: true });
    owner = await createApiTenant(harness, { timezone: "America/New_York" });
    other = await createApiTenant(harness);
  });

  afterAll(async () => {
    await owner.dispose();
    await other.dispose();
    await harness.close();
  });

  describe("when an appointment is created through the API", () => {
    it("stores a confirmation due now and a 24 h reminder due 24 h before the start, both pending", async () => {
      // Given / When
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 3 * DAY));

      // Then
      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "pending", dueAt: iso(0), attempts: 0 },
        { kind: "reminder_24h", status: "pending", dueAt: iso(2 * DAY), attempts: 0 },
      ]);
      const rows = await listRemindersForBusiness(harness.server.db, owner.tenant.businessId);
      const stored = rows.find((row) => row.appointmentId === appointment.id && row.kind === "confirmation");
      expect(stored).toMatchObject({
        businessId: owner.tenant.businessId,
        sentAt: null,
        whatsappMessageId: null,
        lastError: null,
      });
    });

    it("skips the 24 h reminder when the appointment is less than 24 h away", async () => {
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 23 * HOUR));

      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "pending", dueAt: iso(0), attempts: 0 },
      ]);
    });

    it("schedules the 24 h reminder for an appointment one minute beyond the 24 h mark", async () => {
      const appointment = await other.bookOk(new Date(NOW.getTime() + 24 * HOUR + MINUTE), { phone: newPhone() });

      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "pending", dueAt: iso(0), attempts: 0 },
        { kind: "reminder_24h", status: "pending", dueAt: iso(MINUTE), attempts: 0 },
      ]);
    });

    it("does not schedule a 24 h reminder for an appointment exactly 24 h away (the confirmation already covers it)", async () => {
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 24 * HOUR), { phone: newPhone() });

      expect((await remindersOf(harness, appointment.id)).map((row) => row.kind)).toEqual(["confirmation"]);
    });

    it("never reminds an appointment that is already in the past", async () => {
      const appointment = await owner.bookOk(new Date(NOW.getTime() - 5 * HOUR), { phone: newPhone() });

      expect(await remindersOf(harness, appointment.id)).toEqual([]);
    });

    it("leaves no reminder behind when the slot is taken (409), so the first booking keeps exactly its own two", async () => {
      // Given
      const start = new Date(NOW.getTime() + 6 * DAY);
      const first = await owner.bookOk(start, { phone: newPhone() });
      const before = (await listRemindersForBusiness(harness.server.db, owner.tenant.businessId)).length;

      // When
      const second = await owner.book(start, { phone: newPhone() });

      // Then
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: "slot_taken" });
      expect((await listRemindersForBusiness(harness.server.db, owner.tenant.businessId)).length).toBe(before);
      expect((await remindersOf(harness, first.id)).map((row) => row.kind)).toEqual(["confirmation", "reminder_24h"]);
    });
  });

  describe("when an appointment is created through the WhatsApp bot", () => {
    // Default tenant: Bogotá (UTC-5), Monday to Friday 09:00-11:00 local, i.e. 14:00-16:00Z; the clock is Monday 08:00 local.
    let bot: Tenant;
    const book = async (startsAt: string) => {
      const phone = newPhone();
      await bot.customer(phone).tap(`ok:${bot.serviceIds[0]}:${startsAt}`, "button_reply");
      const [appointment] = (await bot.appointments()).filter((row) => row.customerPhone === phone);
      if (!appointment) throw new Error("the bot did not book");
      return appointment;
    };

    beforeAll(async () => {
      bot = await harness.newTenant();
    });

    it("stores the same two reminders", async () => {
      const appointment = await book("2031-03-12T14:00:00.000Z");

      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "pending", dueAt: iso(0), attempts: 0 },
        { kind: "reminder_24h", status: "pending", dueAt: "2031-03-11T14:00:00.000Z", attempts: 0 },
      ]);
    });

    it("stores only the confirmation for a booking less than 24 h away", async () => {
      const appointment = await book("2031-03-10T14:30:00.000Z");

      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "pending", dueAt: iso(0), attempts: 0 },
      ]);
    });

    it("turns the reminders into skipped when the customer cancels through the bot", async () => {
      const appointment = await book("2031-03-13T14:00:00.000Z");

      await bot.customer(appointment.customerPhone).tap(`cancelok:${appointment.id}`, "button_reply");

      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "skipped", dueAt: iso(0), attempts: 0 },
        { kind: "reminder_24h", status: "skipped", dueAt: "2031-03-12T14:00:00.000Z", attempts: 0 },
      ]);
    });
  });

  describe("when an appointment is cancelled", () => {
    it("through the API turns its pending reminders into skipped", async () => {
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 10 * DAY), { phone: newPhone() });

      const res = await owner.call("POST", `/appointments/${appointment.id}/cancel`);

      expect(res.status).toBe(200);
      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "skipped", dueAt: iso(0), attempts: 0 },
        { kind: "reminder_24h", status: "skipped", dueAt: iso(9 * DAY), attempts: 0 },
      ]);
    });

    it("keeps a reminder that was already sent as sent and skips only the pending one", async () => {
      // Given - the confirmation has gone out
      const phone = newPhone();
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 12 * DAY), { phone });
      await harness.sweep();
      expect(harness.client.templatesTo(phone)).toHaveLength(1);

      // When
      await owner.call("POST", `/appointments/${appointment.id}/cancel`);

      // Then
      expect((await remindersOf(harness, appointment.id)).map((row) => `${row.kind}:${row.status}`)).toEqual([
        "confirmation:sent",
        "reminder_24h:skipped",
      ]);
    });

    it("never touches the reminders of another business when its owner tries to cancel (404)", async () => {
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 13 * DAY), { phone: newPhone() });

      const res = await other.call("POST", `/appointments/${appointment.id}/cancel`);

      expect(res.status).toBe(404);
      expect((await remindersOf(harness, appointment.id)).map((row) => row.status)).toEqual(["pending", "pending"]);
    });
  });

  describe("when an appointment is moved", () => {
    it("re-times only the 24 h reminder and leaves the confirmation as it was", async () => {
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 14 * DAY), { phone: newPhone() });

      const res = await owner.call("PATCH", `/appointments/${appointment.id}`, { startsAt: iso(16 * DAY) });

      expect(res.status).toBe(200);
      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "pending", dueAt: iso(0), attempts: 0 },
        { kind: "reminder_24h", status: "pending", dueAt: iso(15 * DAY), attempts: 0 },
      ]);
    });

    it("skips the 24 h reminder when the new start is less than 24 h away", async () => {
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 17 * DAY), { phone: newPhone() });
      harness.clock.now = new Date(NOW.getTime() + 17 * DAY - 10 * HOUR);
      try {
        await owner.call("PATCH", `/appointments/${appointment.id}`, { startsAt: iso(17 * DAY + 2 * HOUR) });
      } finally {
        harness.clock.now = NOW;
      }

      expect((await remindersOf(harness, appointment.id)).map((row) => `${row.kind}:${row.status}`)).toEqual([
        "confirmation:pending",
        "reminder_24h:skipped",
      ]);
    });

    it("creates the 24 h reminder when an appointment that was too close is moved far enough away", async () => {
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 5 * HOUR), { phone: newPhone() });
      expect((await remindersOf(harness, appointment.id)).map((row) => row.kind)).toEqual(["confirmation"]);

      await owner.call("PATCH", `/appointments/${appointment.id}`, { startsAt: iso(19 * DAY) });

      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "pending", dueAt: iso(0), attempts: 0 },
        { kind: "reminder_24h", status: "pending", dueAt: iso(18 * DAY), attempts: 0 },
      ]);
    });

    it("does not send a second confirmation for the new time, and keeps a sent confirmation as sent", async () => {
      // Given
      const phone = newPhone();
      const appointment = await owner.bookOk(new Date(NOW.getTime() + 20 * DAY), { phone });
      await harness.sweep();
      expect(harness.client.templatesTo(phone)).toHaveLength(1);

      // When
      await owner.call("PATCH", `/appointments/${appointment.id}`, { startsAt: iso(22 * DAY) });
      await harness.sweep();

      // Then
      expect(harness.client.templatesTo(phone)).toHaveLength(1);
      expect(await remindersOf(harness, appointment.id)).toEqual([
        { kind: "confirmation", status: "sent", dueAt: iso(0), attempts: 1 },
        { kind: "reminder_24h", status: "pending", dueAt: iso(21 * DAY), attempts: 0 },
      ]);
    });

    it("leaves the reminders alone when the move is refused (409)", async () => {
      const first = await owner.bookOk(new Date(NOW.getTime() + 23 * DAY), { phone: newPhone() });
      const second = await owner.bookOk(new Date(NOW.getTime() + 24 * DAY), { phone: newPhone() });

      const res = await owner.call("PATCH", `/appointments/${second.id}`, { startsAt: iso(23 * DAY) });

      expect(res.status).toBe(409);
      expect((await remindersOf(harness, second.id)).map((row) => row.dueAt)).toEqual([iso(0), iso(23 * DAY)]);
      expect((await remindersOf(harness, first.id)).map((row) => row.dueAt)).toEqual([iso(0), iso(22 * DAY)]);
    });
  });
});

describe("reminders disabled", () => {
  let harness: Harness;
  let owner: ApiTenant;

  beforeAll(async () => {
    harness = await createHarness();
    owner = await createApiTenant(harness);
  });

  afterAll(async () => {
    await owner.dispose();
    await harness.close();
  });

  it("exposes no reminder runtime", () => {
    expect(harness.server.reminders).toBeUndefined();
  });

  it("books through the API without scheduling anything and without errors", async () => {
    const appointment = await owner.bookOk(new Date(NOW.getTime() + 3 * DAY));

    expect(await remindersOf(harness, appointment.id)).toEqual([]);
  });

  it("books through the bot without scheduling anything and without errors", async () => {
    const serviceId = owner.tenant.serviceIds[0] ?? "";

    const phone = newPhone();

    await owner.tenant.customer(phone).tap(`ok:${serviceId}:2031-03-12T14:00:00.000Z`, "button_reply");

    expect((await owner.tenant.appointments()).filter((row) => row.customerPhone === phone)).toHaveLength(1);
    expect(await listRemindersForBusiness(harness.server.db, owner.tenant.businessId)).toEqual([]);
  });

  it("cancels and moves as before", async () => {
    const appointment = await owner.bookOk(new Date(NOW.getTime() + 6 * DAY), { phone: newPhone() });

    expect((await owner.call("PATCH", `/appointments/${appointment.id}`, { startsAt: iso(7 * DAY) })).status).toBe(200);
    expect((await owner.call("POST", `/appointments/${appointment.id}/cancel`)).status).toBe(200);
  });

  it("stays disabled when templates are configured but WhatsApp is not", async () => {
    const server = createServer({
      databaseUrl,
      authSecret,
      authUrl,
      reminders: { templates: TEMPLATES },
    });
    try {
      expect(server.reminders).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("is enabled only when WhatsApp and the templates are both configured", async () => {
    const server = createServer({
      databaseUrl,
      authSecret,
      authUrl,
      whatsapp: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, client: new FakeWhatsAppClient() },
      reminders: { templates: TEMPLATES },
    });
    try {
      expect(server.reminders).toBeDefined();
    } finally {
      await server.close();
    }
  });
});
