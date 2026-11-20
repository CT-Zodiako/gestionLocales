import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelAppointment,
  createAppointment,
  createService,
  ensureBusiness,
  listRemindersForAppointment,
  moveAppointment,
  removeBusinessWithAgenda,
  sql,
  upsertCustomer,
} from "@gestion/db";
import { WhatsAppSendError } from "../src/whatsapp/client.ts";
import { REMINDER_LEASE_MS, createReminderBreaker, sweepReminders } from "../src/reminders/sweep.ts";
import { MINUTE, MONDAY_MORNING, TEMPLATES, createHarness, type Harness, type Tenant } from "./support/whatsapp-harness.ts";
import { DAY, HOUR } from "./support/reminders.ts";
import { FakeWhatsAppClient, templateParams } from "./support/whatsapp.ts";

// These tests drive HTTP/DB round trips that stall past the 5 s default on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const NOW = MONDAY_MORNING; // 2031-03-10T13:00:00Z
const newPhone = () => `57300${randomInt(1_000_000, 9_999_999)}`;
const at = (base: Date, offsetMs: number) => new Date(base.getTime() + offsetMs);

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

describe("reminder sweep", () => {
  let harness: Harness;
  const extraBusinessIds: string[] = [];

  beforeAll(async () => {
    harness = await createHarness({ reminders: true });
  });

  afterEach(() => {
    harness.clock.now = NOW;
    harness.client.templateErrors = [];
    harness.client.templateDelayMs = 0;
    harness.client.beforeTemplate = undefined;
  });

  afterAll(async () => {
    for (const id of extraBusinessIds) await removeBusinessWithAgenda(harness.server.db, id);
    await harness.close();
  });

  const sweep = (tenant: Tenant, extra: Parameters<Harness["sweep"]>[0] = {}) =>
    harness.sweep({ businessIds: [tenant.businessId], ...extra });

  /** Books through the data layer exactly as the server wires it (reminders scheduled with the harness clock). */
  async function schedule(
    tenant: Tenant,
    input: { startsAt: Date; phone?: string; name?: string | null; minutes?: number },
  ) {
    const phone = input.phone ?? newPhone();
    const customer = await upsertCustomer(harness.server.db, { businessId: tenant.businessId, phone, name: input.name ?? null });
    const appointment = await createAppointment(
      harness.server.db,
      {
        businessId: tenant.businessId,
        customerId: customer.id,
        serviceId: tenant.serviceIds[0] ?? "",
        startsAt: input.startsAt,
        endsAt: at(input.startsAt, (input.minutes ?? 30) * MINUTE),
      },
      { scheduleReminders: true, now: () => harness.clock.now },
    );
    return { appointment, phone };
  }

  const rowsOf = (appointmentId: string) => listRemindersForAppointment(harness.server.db, appointmentId);
  const rowOf = async (appointmentId: string, kind: "confirmation" | "reminder_24h") => {
    const row = (await rowsOf(appointmentId)).find((candidate) => candidate.kind === kind);
    if (!row) throw new Error(`no ${kind} reminder`);
    return row;
  };

  /**
   * `count` bookings whose confirmations fell due one minute apart (the first is the oldest), so a sweep claims
   * them in booking order; the clock is back at NOW afterwards.
   */
  async function scheduleDue(tenant: Tenant, count: number) {
    const booked = [];
    for (let index = 0; index < count; index++) {
      harness.clock.now = at(NOW, -(count - index) * MINUTE);
      booked.push(await schedule(tenant, { startsAt: at(NOW, (3 + index) * DAY) }));
    }
    harness.clock.now = NOW;
    return booked;
  }

  describe("sending", () => {
    it("sends a due confirmation exactly once, with the template, language and four parameters", async () => {
      // Given
      const tenant = await harness.newTenant({ timezone: "America/New_York", services: [{ name: "Corte", durationMinutes: 30 }] });
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY), name: "Ana" });

      // When
      const first = await sweep(tenant);
      const second = await sweep(tenant);

      // Then - 2031-03-13T13:00Z is 09:00 EDT
      expect(harness.client.templatesTo(phone)).toHaveLength(1);
      expect(harness.client.templatesTo(phone)[0]).toEqual({
        phoneNumberId: tenant.phoneNumberId,
        message: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: phone,
          type: "template",
          template: {
            name: TEMPLATES.confirmation,
            language: { code: "es" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: "Ana" },
                  { type: "text", text: "Corte" },
                  { type: "text", text: "13/03/2031" },
                  { type: "text", text: "09:00" },
                ],
              },
            ],
          },
        },
      });
      expect(first).toMatchObject({ claimed: 1, sent: 1, skipped: 0, failed: 0, retried: 0 });
      expect(second).toMatchObject({ claimed: 0, sent: 0 });
      const row = await rowOf(appointment.id, "confirmation");
      expect(row).toMatchObject({ status: "sent", attempts: 1, lastError: null });
      expect(row.sentAt?.toISOString()).toBe(NOW.toISOString());
      expect(row.whatsappMessageId).toMatch(/^wamid\./);
      expect((await rowOf(appointment.id, "reminder_24h")).status).toBe("pending");
    });

    it("sends nothing when nothing is due", async () => {
      const tenant = await harness.newTenant();

      expect(await sweep(tenant)).toMatchObject({ claimed: 0, sent: 0, skipped: 0, failed: 0, retried: 0 });
      expect(harness.client.templates.filter((entry) => entry.phoneNumberId === tenant.phoneNumberId)).toEqual([]);
    });

    it("writes date and time in the business timezone around the spring DST change (America/New_York)", async () => {
      // Given - 2031-03-09 is the day the clocks jump from 02:00 to 03:00
      harness.clock.now = new Date("2031-03-06T12:00:00.000Z");
      const tenant = await harness.newTenant({ timezone: "America/New_York" });
      const cases = [
        { startsAt: "2031-03-09T01:00:00.000Z", date: "08/03/2031", time: "20:00" }, // 20:00 EST; still 09/03 in UTC
        { startsAt: "2031-03-09T07:30:00.000Z", date: "09/03/2031", time: "03:30" }, // first half hour after the gap, EDT
        { startsAt: "2031-03-09T16:00:00.000Z", date: "09/03/2031", time: "12:00" }, // 12:00 EDT
        { startsAt: "2031-03-10T03:30:00.000Z", date: "09/03/2031", time: "23:30" }, // 23:30 EDT; already 10/03 in UTC
      ];
      const booked = [];
      for (const [index, item] of cases.entries()) {
        booked.push({ ...item, ...(await schedule(tenant, { startsAt: new Date(item.startsAt), name: `Cliente ${index}` })) });
      }

      // When
      await sweep(tenant);

      // Then
      for (const item of booked) {
        const [sent] = harness.client.templatesTo(item.phone);
        expect(templateParams(must(sent)).slice(2)).toEqual([item.date, item.time]);
      }
    });

    it("sends the 24 h reminder with its own template, only once its due time has come", async () => {
      // Given - the confirmation has gone out; the reminder is due 3 days later
      const tenant = await harness.newTenant({ timezone: "America/New_York" });
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 4 * DAY), name: "Ana" });
      await sweep(tenant);
      const reminderDue = at(NOW, 3 * DAY);

      // When / Then - one millisecond early: nothing
      harness.clock.now = at(reminderDue, -1);
      expect(await sweep(tenant)).toMatchObject({ claimed: 0 });
      expect(harness.client.templatesTo(phone)).toHaveLength(1);

      // on time: the reminder goes out with the reminder template
      harness.clock.now = reminderDue;
      expect(await sweep(tenant)).toMatchObject({ claimed: 1, sent: 1 });
      const sent = harness.client.templatesTo(phone);
      expect(sent.map((entry) => entry.message.template.name)).toEqual([TEMPLATES.confirmation, TEMPLATES.reminder]);
      expect(templateParams(must(sent[1]))).toEqual(["Ana", "Corte", "14/03/2031", "09:00"]);
      expect(await sweep(tenant)).toMatchObject({ claimed: 0 });
      expect((await rowOf(appointment.id, "reminder_24h")).status).toBe("sent");
    });

    it("falls back to 'cliente' without a name and keeps parameters free of line breaks and over-long text", async () => {
      const tenant = await harness.newTenant({ services: [{ name: `Corte\n  de   pelo ${"largo ".repeat(40)}`, durationMinutes: 30 }] });
      const anonymous = await schedule(tenant, { startsAt: at(NOW, 3 * DAY), name: null });
      const verbose = await schedule(tenant, { startsAt: at(NOW, 4 * DAY), name: `Ana\t\n María ${"x".repeat(200)}` });

      await sweep(tenant);

      const [first] = harness.client.templatesTo(anonymous.phone);
      const [second] = harness.client.templatesTo(verbose.phone);
      expect(templateParams(must(first))[0]).toBe("cliente");
      expect(templateParams(must(first))[1]).toMatch(/^Corte de pelo largo/);
      expect(templateParams(must(second))[0]).toMatch(/^Ana María x+/);
      for (const entry of [first, second]) {
        for (const text of templateParams(must(entry))) expect(text.length).toBeLessThanOrEqual(60);
      }
    });

    it("sends at most `batchSize` rows per sweep, one at a time, and the next sweep continues with the rest", async () => {
      const tenant = await harness.newTenant();
      const phones: string[] = [];
      for (let index = 0; index < 5; index++) {
        phones.push((await schedule(tenant, { startsAt: at(NOW, (3 + index) * DAY) })).phone);
      }

      const first = await sweep(tenant, { batchSize: 2 });

      expect(first).toMatchObject({ claimed: 2, sent: 2, paused: false });
      expect(phones.filter((phone) => harness.client.templatesTo(phone).length === 1)).toHaveLength(2);

      const second = await sweep(tenant, { batchSize: 2 });
      const third = await sweep(tenant, { batchSize: 2 });
      const fourth = await sweep(tenant, { batchSize: 2 });

      expect([second.claimed, third.claimed, fourth.claimed]).toEqual([2, 1, 0]);
      for (const phone of phones) expect(harness.client.templatesTo(phone)).toHaveLength(1);
    });

    it("sends every due reminder in one sweep by default (up to 50 rows)", async () => {
      const tenant = await harness.newTenant();
      const phones: string[] = [];
      for (let index = 0; index < 5; index++) {
        phones.push((await schedule(tenant, { startsAt: at(NOW, (3 + index) * DAY) })).phone);
      }

      const summary = await sweep(tenant);

      expect(summary).toMatchObject({ claimed: 5, sent: 5 });
      for (const phone of phones) expect(harness.client.templatesTo(phone)).toHaveLength(1);
    });
  });

  describe("one row at a time", () => {
    it("claims only the row it is sending: the rows behind it stay pending, so a slow send cannot make them outlive the lease", async () => {
      // Given - three due rows; the first send hangs inside Graph
      const tenant = await harness.newTenant();
      const booked = await scheduleDue(tenant, 3);
      const held = harness.client.holdNextTemplate();

      // When
      const slow = sweep(tenant);
      await held.started;

      // Then - only the first row is claimed
      const statuses = async () => Promise.all(booked.map(async (entry) => (await rowOf(entry.appointment.id, "confirmation")).status));
      expect(await statuses()).toEqual(["sending", "pending", "pending"]);
      held.release();
      expect(await slow).toMatchObject({ claimed: 3, sent: 3 });
    });

    it("does not let a second instance retake the rows behind a slow send: each of them is sent exactly once", async () => {
      // Given - three due rows; the first send of instance A hangs for longer than the lease
      const tenant = await harness.newTenant();
      const booked = await scheduleDue(tenant, 3);
      const held = harness.client.holdNextTemplate();
      const instanceA = sweep(tenant);
      await held.started;

      // When - instance B sweeps once the lease of A's in-flight row has expired, then A's slow send finally returns
      harness.clock.now = at(NOW, REMINDER_LEASE_MS + MINUTE);
      const instanceB = await sweep(tenant);
      held.release();
      await instanceA;

      // Then - only the first row (the one whose send overran the lease) can be sent twice; the rows behind it once
      expect(instanceB).toMatchObject({ claimed: 3, sent: 3 });
      expect(harness.client.templatesTo(booked[0]?.phone ?? "").length).toBeLessThanOrEqual(2);
      expect(harness.client.templatesTo(booked[1]?.phone ?? "")).toHaveLength(1);
      expect(harness.client.templatesTo(booked[2]?.phone ?? "")).toHaveLength(1);
      for (const entry of booked) expect((await rowOf(entry.appointment.id, "confirmation")).status).toBe("sent");
    });

    it("sends each reminder exactly once when two sweeps race while every send takes a minute of (injected) time", async () => {
      // Given
      const tenant = await harness.newTenant();
      const phones: string[] = [];
      for (let index = 0; index < 6; index++) {
        phones.push((await schedule(tenant, { startsAt: at(NOW, (3 + index) * DAY) })).phone);
      }
      harness.client.templateDelayMs = 20;
      harness.client.beforeTemplate = () => {
        harness.clock.now = at(harness.clock.now, MINUTE);
      };

      // When - (a long budget: this test is about the lease, not about the budget)
      const [a, b] = await Promise.all([sweep(tenant, { timeBudgetMs: 60 * MINUTE }), sweep(tenant, { timeBudgetMs: 60 * MINUTE })]);

      // Then
      for (const phone of phones) expect(harness.client.templatesTo(phone)).toHaveLength(1);
      expect(a.sent + b.sent).toBe(6);
      expect(a.claimed + b.claimed).toBe(6);
    });

    it.each([2, 3, 6])(
      "sends each reminder exactly once across %i independent sweep instances (separate clients, 25 ms Graph) over 18 rows",
      async (instances) => {
        // Given - 18 due rows and N instances that share nothing but the database
        const tenant = await harness.newTenant();
        const booked = await scheduleDue(tenant, 18);
        const clients = Array.from({ length: instances }, () => {
          const client = new FakeWhatsAppClient();
          client.templateDelayMs = 25;
          return client;
        });

        // When
        const summaries = await Promise.all(
          clients.map((client) =>
            sweepReminders(
              { db: harness.server.db, client, templates: TEMPLATES, now: () => NOW },
              { businessIds: [tenant.businessId] },
            ),
          ),
        );

        // Then
        for (const entry of booked) {
          const sends = clients.reduce((total, client) => total + client.templatesTo(entry.phone).length, 0);
          expect(sends).toBe(1);
        }
        expect(summaries.reduce((total, summary) => total + summary.claimed, 0)).toBe(18);
        expect(summaries.reduce((total, summary) => total + summary.sent, 0)).toBe(18);
        const rows = await Promise.all(booked.map((entry) => rowOf(entry.appointment.id, "confirmation")));
        expect(rows.every((row) => row.status === "sent" && row.attempts === 1)).toBe(true);
      },
    );

    it("keeps a row that has been sending for 4:59.999 and retakes it at exactly 5:00 as attempt 2 (the documented duplicate)", async () => {
      // Given - a send that hangs inside Graph since NOW
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      const held = harness.client.holdNextTemplate();
      const stuck = sweep(tenant);
      await held.started;
      const calls = harness.client.templateCalls;

      // When / Then - one millisecond short of the lease: untouched
      harness.clock.now = at(NOW, REMINDER_LEASE_MS - 1);
      expect(await sweep(tenant)).toMatchObject({ claimed: 0, sent: 0 });
      expect(harness.client.templateCalls).toBe(calls);
      expect(await rowOf(appointment.id, "confirmation")).toMatchObject({ status: "sending", attempts: 1 });

      // When / Then - at the lease: retaken, counted as the second attempt
      harness.clock.now = at(NOW, REMINDER_LEASE_MS);
      expect(await sweep(tenant)).toMatchObject({ claimed: 1, sent: 1 });
      expect(await rowOf(appointment.id, "confirmation")).toMatchObject({ status: "sent", attempts: 2 });
      expect(harness.client.templatesTo(phone)).toHaveLength(1);

      // and the slow first send, if it did reach Graph, is the duplicate: the row keeps the retaker's result
      const winner = await rowOf(appointment.id, "confirmation");
      held.release();
      await stuck;
      expect(harness.client.templatesTo(phone)).toHaveLength(2);
      expect(await rowOf(appointment.id, "confirmation")).toMatchObject({ status: "sent", attempts: 2, whatsappMessageId: winner.whatsappMessageId });
    });

    it("stops after the 4 minute time budget (injected clock) and leaves the rest pending for the next sweep", async () => {
      // Given - ten due rows and a Graph that takes 90 seconds per send
      const tenant = await harness.newTenant();
      const phones = (await scheduleDue(tenant, 10)).map((entry) => entry.phone);
      harness.client.beforeTemplate = () => {
        harness.clock.now = at(harness.clock.now, 90_000);
      };

      // When - elapsed time is 0, 1.5 and 3 minutes before each of the first three rows, 4.5 after the third
      const first = await sweep(tenant);

      // Then
      expect(first).toMatchObject({ claimed: 3, sent: 3, paused: false });
      expect(phones.filter((phone) => harness.client.templatesTo(phone).length === 1)).toHaveLength(3);

      // and the next sweep carries on with the rest (three more within its own budget)
      const second = await sweep(tenant);
      expect(second).toMatchObject({ claimed: 3, sent: 3 });
    });

    it("honours a custom time budget", async () => {
      const tenant = await harness.newTenant();
      await scheduleDue(tenant, 4);
      harness.client.beforeTemplate = () => {
        harness.clock.now = at(harness.clock.now, MINUTE);
      };

      const summary = await sweep(tenant, { timeBudgetMs: 90_000 });

      expect(summary).toMatchObject({ claimed: 2, sent: 2 });
    });

    it("stops between rows when the stop signal is raised: the row in flight finishes, the rest stay pending and unclaimed", async () => {
      // Given
      const tenant = await harness.newTenant();
      const booked = await scheduleDue(tenant, 3);
      const stop = new AbortController();

      // When - the signal is raised while the first row is being processed
      const summary = await sweep(tenant, { signal: stop.signal, afterClaim: () => stop.abort() });

      // Then
      expect(summary).toMatchObject({ claimed: 1, sent: 1 });
      expect(harness.client.templatesTo(booked[0]?.phone ?? "")).toHaveLength(1);
      const rows = await Promise.all(booked.map((entry) => rowOf(entry.appointment.id, "confirmation")));
      expect(rows.map((row) => [row.status, row.attempts])).toEqual([["sent", 1], ["pending", 0], ["pending", 0]]);
    });

    it("claims nothing when the signal was already raised", async () => {
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      const calls = harness.client.templateCalls;

      const summary = await sweep(tenant, { signal: AbortSignal.abort() });

      expect(summary).toMatchObject({ claimed: 0, sent: 0 });
      expect(harness.client.templateCalls).toBe(calls);
      expect(harness.client.templatesTo(phone)).toEqual([]);
      expect(await rowOf(appointment.id, "confirmation")).toMatchObject({ status: "pending", attempts: 0 });
    });
  });

  describe("concurrency", () => {
    it("sends each reminder exactly once across 20 concurrent sweeps", async () => {
      // Given
      const tenant = await harness.newTenant();
      const phones: string[] = [];
      for (let index = 0; index < 4; index++) {
        phones.push((await schedule(tenant, { startsAt: at(NOW, (3 + index) * DAY) })).phone);
      }
      harness.client.templateDelayMs = 30;

      // When
      const summaries = await Promise.all(Array.from({ length: 20 }, () => sweep(tenant, { batchSize: 1 })));

      // Then
      for (const phone of phones) expect(harness.client.templatesTo(phone)).toHaveLength(1);
      expect(summaries.reduce((total, summary) => total + summary.sent, 0)).toBe(4);
      expect(summaries.reduce((total, summary) => total + summary.claimed, 0)).toBe(4);
    });
  });

  describe("send-time checks", () => {
    it("skips, without sending, a reminder whose appointment is cancelled after it was claimed", async () => {
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });

      const summary = await sweep(tenant, {
        afterClaim: async () => {
          await cancelAppointment(harness.server.db, tenant.businessId, appointment.id);
        },
      });

      expect(summary).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
      expect(harness.client.templatesTo(phone)).toEqual([]);
      const row = await rowOf(appointment.id, "confirmation");
      expect(row.status).toBe("skipped");
      expect(row.lastError).toMatch(/cancel/i);
    });

    it("skips a reminder whose appointment has already started by the time it is swept", async () => {
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 2 * HOUR) });

      harness.clock.now = at(NOW, 3 * HOUR);
      const summary = await sweep(tenant);

      expect(summary).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
      expect(harness.client.templatesTo(phone)).toEqual([]);
      expect((await rowOf(appointment.id, "confirmation")).lastError).toMatch(/past/i);
    });

    it("skips a reminder whose customer has no usable phone", async () => {
      const tenant = await harness.newTenant();
      const { appointment } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY), phone: "  " });

      const summary = await sweep(tenant);

      expect(summary).toMatchObject({ sent: 0, skipped: 1 });
      expect(harness.client.templates.filter((entry) => entry.phoneNumberId === tenant.phoneNumberId)).toEqual([]);
      expect((await rowOf(appointment.id, "confirmation")).lastError).toMatch(/phone/i);
    });

    it("skips, with a reason, a reminder of a business that has no WhatsApp channel", async () => {
      // Given - a business without a registered number
      const business = await ensureBusiness(harness.server.db, `No channel ${randomUUID()}`);
      extraBusinessIds.push(business.id);
      const service = await createService(harness.server.db, { businessId: business.id, name: "Corte", durationMinutes: 30 });
      const phone = newPhone();
      const customer = await upsertCustomer(harness.server.db, { businessId: business.id, phone });
      const appointment = await createAppointment(
        harness.server.db,
        { businessId: business.id, customerId: customer.id, serviceId: service.id, startsAt: at(NOW, 3 * DAY), endsAt: at(NOW, 3 * DAY + 30 * MINUTE) },
        { scheduleReminders: true, now: () => harness.clock.now },
      );

      // When
      const summary = await harness.sweep({ businessIds: [business.id] });

      // Then
      expect(summary).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
      expect(harness.client.templatesTo(phone)).toEqual([]);
      const row = await rowOf(appointment.id, "confirmation");
      expect(row.status).toBe("skipped");
      expect(row.lastError).toMatch(/channel/i);
    });
  });

  describe("failures", () => {
    const transient: Array<[string, () => Error]> = [
      ["a 500", () => new WhatsAppSendError(500)],
      ["a 503", () => new WhatsAppSendError(503)],
      ["a 408", () => new WhatsAppSendError(408)],
      ["a 429", () => new WhatsAppSendError(429)],
      ["a network error", () => new TypeError("fetch failed")],
    ];

    it.each(transient)("retries after %s: back to pending, one attempt counted, due in one minute", async (_name, makeError) => {
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      harness.client.templateErrors = [makeError()];

      const summary = await sweep(tenant);

      expect(summary).toMatchObject({ claimed: 1, sent: 0, retried: 1, failed: 0 });
      const row = await rowOf(appointment.id, "confirmation");
      expect(row).toMatchObject({ status: "pending", attempts: 1 });
      expect(row.dueAt.toISOString()).toBe(at(NOW, MINUTE).toISOString());
      expect(row.lastError).toEqual(expect.any(String));
      expect(harness.client.templatesTo(phone)).toEqual([]);
    });

    it("backs off 1, 5 and 30 minutes and gives up after the fourth attempt", async () => {
      // Given
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 5 * DAY) });
      harness.client.templateErrors = [1, 2, 3, 4, 5].map(() => new WhatsAppSendError(503));
      const state = async () => {
        const row = await rowOf(appointment.id, "confirmation");
        return { status: row.status, attempts: row.attempts, dueAt: row.dueAt.toISOString() };
      };
      const calls = () => harness.client.templateCalls;
      const before = calls();

      // When / Then - attempt 1
      await sweep(tenant);
      expect(await state()).toEqual({ status: "pending", attempts: 1, dueAt: at(NOW, 1 * MINUTE).toISOString() });

      // not yet due: no Graph call
      harness.clock.now = at(NOW, 1 * MINUTE - 1);
      await sweep(tenant);
      expect(calls() - before).toBe(1);

      // attempt 2, then 5 minutes
      harness.clock.now = at(NOW, 1 * MINUTE);
      await sweep(tenant);
      expect(await state()).toEqual({ status: "pending", attempts: 2, dueAt: at(NOW, 6 * MINUTE).toISOString() });

      // attempt 3, then 30 minutes
      harness.clock.now = at(NOW, 6 * MINUTE);
      await sweep(tenant);
      expect(await state()).toEqual({ status: "pending", attempts: 3, dueAt: at(NOW, 36 * MINUTE).toISOString() });

      // attempt 4: failed for good
      harness.clock.now = at(NOW, 36 * MINUTE);
      const last = await sweep(tenant);
      expect(last).toMatchObject({ failed: 1, retried: 0 });
      expect((await state()).status).toBe("failed");
      expect((await state()).attempts).toBe(4);
      expect((await rowOf(appointment.id, "confirmation")).lastError).toMatch(/503/);

      // and never again
      harness.clock.now = at(NOW, 3 * HOUR);
      await sweep(tenant);
      expect(calls() - before).toBe(4);
      expect(harness.client.templatesTo(phone)).toEqual([]);
    });

    it("sends on the second attempt after one transient failure and clears the error", async () => {
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      harness.client.templateErrors = [new WhatsAppSendError(502)];
      await sweep(tenant);

      harness.clock.now = at(NOW, MINUTE);
      const summary = await sweep(tenant);

      expect(summary).toMatchObject({ sent: 1 });
      expect(harness.client.templatesTo(phone)).toHaveLength(1);
      expect(await rowOf(appointment.id, "confirmation")).toMatchObject({ status: "sent", attempts: 2, lastError: null });
    });

    it.each([400, 404])("fails at once after a permanent %i and never retries", async (status) => {
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      harness.client.templateErrors = [new WhatsAppSendError(status)];
      const before = harness.client.templateCalls;

      const summary = await sweep(tenant);
      harness.clock.now = at(NOW, 2 * HOUR);
      await sweep(tenant);

      expect(summary).toMatchObject({ claimed: 1, failed: 1, retried: 0, sent: 0 });
      expect(await rowOf(appointment.id, "confirmation")).toMatchObject({ status: "failed", attempts: 1 });
      expect((await rowOf(appointment.id, "confirmation")).lastError).toContain(String(status));
      expect(harness.client.templateCalls - before).toBe(1);
      expect(harness.client.templatesTo(phone)).toEqual([]);
    });

    it("keeps one failing reminder from blocking the others", async () => {
      const tenant = await harness.newTenant();
      const first = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      const second = await schedule(tenant, { startsAt: at(NOW, 4 * DAY) });
      harness.client.templateErrors = [new WhatsAppSendError(400)];

      const summary = await sweep(tenant);

      expect(summary).toMatchObject({ claimed: 2, sent: 1, failed: 1 });
      const statuses = [
        (await rowOf(first.appointment.id, "confirmation")).status,
        (await rowOf(second.appointment.id, "confirmation")).status,
      ].sort();
      expect(statuses).toEqual(["failed", "sent"]);
    });
  });

  describe("authentication errors (circuit breaker)", () => {
    const AUTH_ERROR_MESSAGE = "WhatsApp authentication failed; pausing reminders";
    const authErrors: Array<[string, () => Error]> = [
      ["HTTP 401", () => new WhatsAppSendError(401)],
      ["HTTP 403", () => new WhatsAppSendError(403)],
      ["Graph error code 190 (with a 400)", () => new WhatsAppSendError(400, 190)],
    ];

    async function threeDue(tenant: Tenant) {
      const booked = await scheduleDue(tenant, 3);
      return booked;
    }

    it.each(authErrors)(
      "after %s the row goes back to pending without losing an attempt, the sweep stops and the rows behind are not touched",
      async (_name, makeError) => {
        // Given
        const tenant = await harness.newTenant();
        const booked = await threeDue(tenant);
        harness.client.templateErrors = [makeError()];
        const calls = harness.client.templateCalls;
        const logsBefore = harness.logs.length;

        // When
        const summary = await sweep(tenant, { breaker: createReminderBreaker() });

        // Then
        expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 0, retried: 0, deferred: 1, paused: true });
        expect(harness.client.templateCalls - calls).toBe(1);
        const rows = await Promise.all(booked.map((entry) => rowOf(entry.appointment.id, "confirmation")));
        expect(rows.map((row) => [row.status, row.attempts])).toEqual([["pending", 0], ["pending", 0], ["pending", 0]]);
        expect(rows[0]?.lastError).toEqual(expect.any(String));
        expect(rows[0]?.lastError).toMatch(/authentication|40[13]|190/i);
        expect(rows[0]?.dueAt.toISOString()).toBe(at(NOW, -3 * MINUTE).toISOString());

        const errorLines = harness.logs.slice(logsBefore).filter((line) => line.startsWith("error "));
        expect(errorLines).toHaveLength(1);
        expect(errorLines[0]).toContain(AUTH_ERROR_MESSAGE);
        const recorded = [...harness.logs.slice(logsBefore), ...rows.map((row) => row.lastError ?? "")].join("\n");
        for (const entry of booked) expect(recorded).not.toContain(entry.phone);
        expect(recorded).not.toMatch(/5730\d{3}/);
      },
    );

    it("pauses for 10 minutes: no claim and no send while paused, then one sweep is tried and a success sends everything", async () => {
      // Given - the breaker is open since NOW
      const tenant = await harness.newTenant();
      const booked = await threeDue(tenant);
      const breaker = createReminderBreaker();
      harness.client.templateErrors = [new WhatsAppSendError(401)];
      await sweep(tenant, { breaker });
      const calls = harness.client.templateCalls;

      // When - just before the pause ends
      harness.clock.now = at(NOW, 10 * MINUTE - 1);
      const paused = await sweep(tenant, { breaker });

      // Then
      expect(paused).toMatchObject({ claimed: 0, sent: 0, paused: true });
      expect(harness.client.templateCalls).toBe(calls);
      const rows = await Promise.all(booked.map((entry) => rowOf(entry.appointment.id, "confirmation")));
      expect(rows.map((row) => [row.status, row.attempts])).toEqual([["pending", 0], ["pending", 0], ["pending", 0]]);

      // When - the pause is over and the token works again
      harness.clock.now = at(NOW, 10 * MINUTE);
      const resumed = await sweep(tenant, { breaker });

      // Then - the overdue rows go out, the first one on its first counted attempt
      expect(resumed).toMatchObject({ claimed: 3, sent: 3, deferred: 0, paused: false });
      for (const entry of booked) expect(harness.client.templatesTo(entry.phone)).toHaveLength(1);
      expect((await rowOf(booked[0]?.appointment.id ?? "", "confirmation")).attempts).toBe(1);

      // and the breaker is closed: a later sweep is not paused
      harness.clock.now = at(NOW, 11 * MINUTE);
      expect(await sweep(tenant, { breaker })).toMatchObject({ claimed: 0, paused: false });
    });

    it("opens again for another 10 minutes when the single sweep tried after the pause still gets an authentication error", async () => {
      const tenant = await harness.newTenant();
      const booked = await threeDue(tenant);
      const breaker = createReminderBreaker();
      harness.client.templateErrors = [new WhatsAppSendError(403), new WhatsAppSendError(403)];
      await sweep(tenant, { breaker });

      harness.clock.now = at(NOW, 10 * MINUTE);
      const retry = await sweep(tenant, { breaker });
      harness.clock.now = at(NOW, 19 * MINUTE);
      const stillPaused = await sweep(tenant, { breaker });
      harness.clock.now = at(NOW, 20 * MINUTE);
      const recovered = await sweep(tenant, { breaker });

      expect(retry).toMatchObject({ claimed: 1, deferred: 1, paused: true });
      expect(stillPaused).toMatchObject({ claimed: 0, paused: true });
      expect(recovered).toMatchObject({ claimed: 3, sent: 3, paused: false });
      expect((await rowOf(booked[0]?.appointment.id ?? "", "confirmation")).attempts).toBe(1);
    });

    it("does not pause on other 4xx (rejected per row) or on transient errors", async () => {
      const tenant = await harness.newTenant();
      const booked = await threeDue(tenant);
      const breaker = createReminderBreaker();
      harness.client.templateErrors = [new WhatsAppSendError(400, 132001), new WhatsAppSendError(503)];

      const summary = await sweep(tenant, { breaker });

      expect(summary).toMatchObject({ claimed: 3, failed: 1, retried: 1, sent: 1, deferred: 0, paused: false });
      const statuses = await Promise.all(booked.map(async (entry) => (await rowOf(entry.appointment.id, "confirmation")).status));
      expect(statuses).toEqual(["failed", "pending", "sent"]);
    });

    it("a send that succeeds while another sweep opens the breaker does not close it: both sweeps stop and nothing more is sent", async () => {
      // Given - three due rows and one shared breaker. Sweep A's first send hangs inside Graph; sweep B's send is refused.
      const tenant = await harness.newTenant();
      const booked = await scheduleDue(tenant, 3);
      const breaker = createReminderBreaker();
      const held = harness.client.holdNextTemplate();
      const sweepA = sweep(tenant, { breaker });
      await held.started;
      harness.client.templateErrors = [new WhatsAppSendError(401)];
      const summaryB = await sweep(tenant, { breaker });
      expect(summaryB).toMatchObject({ claimed: 1, deferred: 1, paused: true });

      // When - A's slow send finally succeeds
      held.release();
      const summaryA = await sweepA;

      // Then - A records its send but must not resume: B's authentication error still stands
      expect(summaryA).toMatchObject({ claimed: 1, sent: 1, paused: true });
      const rows = await Promise.all(booked.map((entry) => rowOf(entry.appointment.id, "confirmation")));
      expect(rows.map((row) => [row.status, row.attempts])).toEqual([["sent", 1], ["pending", 0], ["pending", 0]]);
      const calls = harness.client.templateCalls;
      expect(await sweep(tenant, { breaker })).toMatchObject({ claimed: 0, paused: true });
      expect(harness.client.templateCalls).toBe(calls);
    });

    it("keeps skipping what became unsendable during a pause: after it only the untouched rows are sent", async () => {
      // Given - six due rows; the first send is refused, which opens the breaker at NOW
      const tenant = await harness.newTenant();
      const booked = await scheduleDue(tenant, 6);
      const [untouched, rawCancelled, rawMoved, cancelled, moved, alsoUntouched] = booked.map((entry) => entry.appointment);
      const breaker = createReminderBreaker();
      harness.client.templateErrors = [new WhatsAppSendError(401)];
      expect(await sweep(tenant, { breaker })).toMatchObject({ claimed: 1, deferred: 1, paused: true });

      // When - during the pause: a cancel and a move to the past written straight to the table (nothing re-times the
      // reminders), and the same two through the data layer the API uses
      const db = harness.server.db;
      const past = (offset: number) => at(NOW, offset).toISOString();
      await db.execute(sql`update appointments set status = 'cancelled' where id = ${must(rawCancelled).id}`);
      await db.execute(
        sql`update appointments set starts_at = ${past(-2 * HOUR)}::timestamptz, ends_at = ${past(-2 * HOUR + 30 * MINUTE)}::timestamptz where id = ${must(rawMoved).id}`,
      );
      await cancelAppointment(db, tenant.businessId, must(cancelled).id);
      await moveAppointment(db, tenant.businessId, must(moved).id, at(NOW, -HOUR), at(NOW, -HOUR + 30 * MINUTE), { now: () => harness.clock.now });
      harness.clock.now = at(NOW, 10 * MINUTE);
      const calls = harness.client.templateCalls;
      const summary = await sweep(tenant, { breaker });

      // Then - R0 and R5 go out; the others are skipped at send time (or already skipped by the data layer) without a Graph call
      expect(summary).toMatchObject({ claimed: 5, sent: 2, skipped: 3, failed: 0, paused: false });
      expect(harness.client.templateCalls - calls).toBe(2);
      for (const sent of [untouched, alsoUntouched]) {
        expect(harness.client.templatesTo(booked[booked.findIndex((entry) => entry.appointment.id === must(sent).id)]?.phone ?? "")).toHaveLength(1);
      }
      for (const entry of booked) {
        const row = await rowOf(entry.appointment.id, "confirmation");
        const expected = [untouched, alsoUntouched].some((kept) => kept?.id === entry.appointment.id) ? "sent" : "skipped";
        expect(row.status).toBe(expected);
        if (expected === "skipped") expect(harness.client.templatesTo(entry.phone)).toEqual([]);
      }
      expect((await rowOf(must(rawCancelled).id, "confirmation")).lastError).toMatch(/cancelled/i);
      expect((await rowOf(must(rawMoved).id, "confirmation")).lastError).toMatch(/past/i);
      expect((await rowOf(must(cancelled).id, "confirmation")).lastError).toMatch(/cancelled/i);
      expect((await rowOf(must(moved).id, "confirmation")).lastError).toMatch(/past/i);
      expect((await rowOf(must(untouched).id, "confirmation")).attempts).toBe(1);
    });

    it("counts attempts across a retry, a refused token, a second refusal after the pause and the final send", async () => {
      // Given - one due row
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      const breaker = createReminderBreaker();
      const state = async () => {
        const row = await rowOf(appointment.id, "confirmation");
        return { status: row.status, attempts: row.attempts, dueAt: row.dueAt.toISOString() };
      };
      harness.client.templateErrors = [new WhatsAppSendError(503), new WhatsAppSendError(401), new WhatsAppSendError(403)];
      const before = harness.client.templateCalls;
      const calls = () => harness.client.templateCalls - before;

      // 1. a 503: a transient failure uses the attempt and backs off one minute
      expect(await sweep(tenant, { breaker })).toMatchObject({ retried: 1, paused: false });
      expect(await state()).toEqual({ status: "pending", attempts: 1, dueAt: at(NOW, MINUTE).toISOString() });

      // 2. a 401: the attempt is refunded (still 1), the row stays due, the breaker opens
      harness.clock.now = at(NOW, MINUTE);
      expect(await sweep(tenant, { breaker })).toMatchObject({ claimed: 1, deferred: 1, paused: true });
      expect(await state()).toEqual({ status: "pending", attempts: 1, dueAt: at(NOW, MINUTE).toISOString() });

      // 3. paused: nothing is claimed or sent
      harness.clock.now = at(NOW, 11 * MINUTE - 1);
      expect(await sweep(tenant, { breaker })).toMatchObject({ claimed: 0, paused: true });
      expect(calls()).toBe(2);

      // 4. after the pause a 403: still attempt 1, paused for another 10 minutes
      harness.clock.now = at(NOW, 11 * MINUTE);
      expect(await sweep(tenant, { breaker })).toMatchObject({ claimed: 1, deferred: 1, paused: true });
      expect(await state()).toEqual({ status: "pending", attempts: 1, dueAt: at(NOW, MINUTE).toISOString() });
      harness.clock.now = at(NOW, 21 * MINUTE - 1);
      expect(await sweep(tenant, { breaker })).toMatchObject({ claimed: 0, paused: true });
      expect(calls()).toBe(3);

      // 5. the pause is over and Graph accepts: sent, on the second attempt in total
      harness.clock.now = at(NOW, 21 * MINUTE);
      expect(await sweep(tenant, { breaker })).toMatchObject({ claimed: 1, sent: 1, paused: false });
      expect((await state()).status).toBe("sent");
      expect((await state()).attempts).toBe(2);
      expect(calls()).toBe(4);
      expect(harness.client.templatesTo(phone)).toHaveLength(1);
    });

    it("keeps one breaker per WhatsApp client when none is passed (the worker never passes one)", async () => {
      // Given - a harness of its own, so its client has not seen any other test's breaker
      const own = await createHarness({ reminders: true });
      try {
        const tenant = await own.newTenant();
        const first = await (async () => {
          const customer = await upsertCustomer(own.server.db, { businessId: tenant.businessId, phone: newPhone(), name: null });
          return createAppointment(
            own.server.db,
            { businessId: tenant.businessId, customerId: customer.id, serviceId: tenant.serviceIds[0] ?? "", startsAt: at(NOW, 3 * DAY), endsAt: at(NOW, 3 * DAY + 30 * MINUTE) },
            { scheduleReminders: true, now: () => own.clock.now },
          );
        })();
        own.client.templateErrors = [new WhatsAppSendError(401)];

        // When
        const tripped = await own.sweep({ businessIds: [tenant.businessId] });
        const calls = own.client.templateCalls;
        const paused = await own.sweep({ businessIds: [tenant.businessId] });

        // Then
        expect(tripped).toMatchObject({ claimed: 1, deferred: 1, paused: true });
        expect(paused).toMatchObject({ claimed: 0, paused: true });
        expect(own.client.templateCalls).toBe(calls);
        expect((await listRemindersForAppointment(own.server.db, first.id)).map((row) => [row.kind, row.status, row.attempts])).toEqual([
          ["confirmation", "pending", 0],
          ["reminder_24h", "pending", 0],
        ]);
      } finally {
        await own.close();
      }
    });
  });

  describe("a worker that dies while sending", () => {
    it("is not retaken within 5 minutes but is retaken after them, counting the extra attempt", async () => {
      // Given - the first sweep claims the row and then hangs inside the Graph call (as a killed process would)
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      const held = harness.client.holdNextTemplate();
      const stuck = sweep(tenant);
      await held.started;
      expect((await rowOf(appointment.id, "confirmation")).status).toBe("sending");

      // When - 4 minutes later nobody may take it
      harness.clock.now = at(NOW, 4 * MINUTE);
      const early = await sweep(tenant);

      // Then
      expect(early).toMatchObject({ claimed: 0 });
      expect(harness.client.templatesTo(phone)).toEqual([]);

      // When - after the lease
      harness.clock.now = at(NOW, 5 * MINUTE + 1);
      const retaken = await sweep(tenant);

      // Then
      expect(retaken).toMatchObject({ claimed: 1, sent: 1 });
      expect(harness.client.templatesTo(phone)).toHaveLength(1);
      expect(await rowOf(appointment.id, "confirmation")).toMatchObject({ status: "sent", attempts: 2 });

      // Cleanup - the dead worker's call finally fails; its stale claim must not change the row
      held.release(new Error("worker died"));
      await stuck;
      expect(await rowOf(appointment.id, "confirmation")).toMatchObject({ status: "sent", attempts: 2 });
    });

    it("may repeat the send once if the old worker had in fact reached Graph (documented limit), without corrupting the row", async () => {
      // Given
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      const held = harness.client.holdNextTemplate();
      const slow = sweep(tenant);
      await held.started;
      harness.clock.now = at(NOW, 6 * MINUTE);
      await sweep(tenant);
      const winner = await rowOf(appointment.id, "confirmation");

      // When - the old worker's Graph call completes after all
      held.release();
      await slow;

      // Then - at most one repeat, and the stored outcome is the retaker's
      expect(harness.client.templatesTo(phone).length).toBeLessThanOrEqual(2);
      const row = await rowOf(appointment.id, "confirmation");
      expect(row.status).toBe("sent");
      expect(row.whatsappMessageId).toBe(winner.whatsappMessageId);
      expect(row.attempts).toBe(2);
    });

    it("stops retaking a row that keeps dying: after 4 attempts it is failed without another send", async () => {
      const tenant = await harness.newTenant();
      const { appointment, phone } = await schedule(tenant, { startsAt: at(NOW, 3 * DAY) });
      const stuck: Array<Promise<unknown>> = [];
      const helds = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const held = harness.client.holdNextTemplate();
        helds.push(held);
        harness.clock.now = at(NOW, attempt * 6 * MINUTE);
        stuck.push(sweep(tenant));
        await held.started;
      }

      harness.clock.now = at(NOW, 4 * 6 * MINUTE);
      const summary = await sweep(tenant);

      expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
      expect(await rowOf(appointment.id, "confirmation")).toMatchObject({ status: "failed", attempts: 5 });
      expect(harness.client.templatesTo(phone)).toEqual([]);
      for (const held of helds) held.release(new Error("worker died"));
      await Promise.all(stuck);
      expect((await rowOf(appointment.id, "confirmation")).status).toBe("failed");
    });
  });

  describe("isolation between businesses", () => {
    it("sends each business's reminders through its own number, timezone and customers only", async () => {
      // Given
      const newYork = await harness.newTenant({ timezone: "America/New_York" });
      const bogota = await harness.newTenant({ timezone: "America/Bogota" });
      const a = await schedule(newYork, { startsAt: new Date("2031-03-13T01:00:00.000Z"), name: "Ana" });
      const b = await schedule(bogota, { startsAt: new Date("2031-03-13T01:00:00.000Z"), name: "Beto" });

      // When - one sweep over both
      await harness.sweep({ businessIds: [newYork.businessId, bogota.businessId] });

      // Then - 01:00Z is 21:00 the day before in New York (EDT) and 20:00 the day before in Bogotá
      const [sentA] = harness.client.templatesTo(a.phone);
      const [sentB] = harness.client.templatesTo(b.phone);
      expect(sentA?.phoneNumberId).toBe(newYork.phoneNumberId);
      expect(sentB?.phoneNumberId).toBe(bogota.phoneNumberId);
      expect(templateParams(must(sentA))).toEqual(["Ana", "Corte", "12/03/2031", "21:00"]);
      expect(templateParams(must(sentB))).toEqual(["Beto", "Corte", "12/03/2031", "20:00"]);
      expect(harness.client.templatesTo(a.phone)).toHaveLength(1);
      expect(harness.client.templatesTo(b.phone)).toHaveLength(1);
    });

    it("leaves other businesses' reminders alone when a sweep is scoped to one business", async () => {
      const first = await harness.newTenant();
      const second = await harness.newTenant();
      const a = await schedule(first, { startsAt: at(NOW, 3 * DAY) });
      const b = await schedule(second, { startsAt: at(NOW, 3 * DAY) });

      await sweep(first);

      expect(harness.client.templatesTo(a.phone)).toHaveLength(1);
      expect(harness.client.templatesTo(b.phone)).toEqual([]);
      expect((await rowOf(b.appointment.id, "confirmation")).status).toBe("pending");
    });
  });

  describe("what is recorded", () => {
    it("keeps phone numbers, names and credentials out of last_error and the logs, for transient and permanent failures", async () => {
      // Given - client errors that carry the recipient and a token in their message, as a careless HTTP library could
      const tenant = await harness.newTenant();
      const phone = "573009998877";
      const token = "EAAB-throwaway-token-9f3a";
      const name = "Ana Reservada";
      const transient = await schedule(tenant, { startsAt: at(NOW, 3 * DAY), phone, name });
      const permanent = await schedule(tenant, { startsAt: at(NOW, 4 * DAY), phone: "573008887766", name: "Beto Reservado" });
      harness.client.templateErrors = [
        new Error(`connect ECONNREFUSED sending to ${phone} with Bearer ${token} for ${name}`),
        new Error(`400 invalid recipient 573008887766 token ${token} (Beto Reservado)`),
      ];
      const logsBefore = harness.logs.length;

      // When
      await sweep(tenant);
      harness.clock.now = at(NOW, 2 * HOUR);
      await sweep(tenant);

      // Then
      const rows = [...(await rowsOf(transient.appointment.id)), ...(await rowsOf(permanent.appointment.id))];
      const recorded = [...rows.map((row) => row.lastError ?? ""), ...harness.logs.slice(logsBefore)].join("\n");
      for (const secret of [phone, "573008887766", "***8877", token, "Ana", "Beto", "Reservad"]) {
        expect(recorded).not.toContain(secret);
      }
      // A bare last-four leak (not just the masked form) must fail too; the lookarounds keep the hex of random UUIDs out of the way.
      expect(recorded).not.toMatch(/(?<![0-9a-f-])(8877|7766)(?![0-9a-f-])/);
    });

    it("logs a successful send without the recipient or the customer name", async () => {
      const tenant = await harness.newTenant();
      await schedule(tenant, { startsAt: at(NOW, 3 * DAY), phone: "573005554433", name: "Carla Privada" });
      const logsBefore = harness.logs.length;

      await sweep(tenant);

      const logged = harness.logs.slice(logsBefore).join("\n");
      expect(logged).not.toContain("573005554433");
      expect(logged).not.toContain("Carla");
    });
  });
});
