import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cancelAppointment,
  createAppointment,
  createService,
  ensureBusiness,
  listRemindersForAppointment,
  removeBusinessWithAgenda,
  upsertCustomer,
} from "@gestion/db";
import { WhatsAppSendError } from "../src/whatsapp/client.ts";
import { MINUTE, MONDAY_MORNING, TEMPLATES, createHarness, type Harness, type Tenant } from "./support/whatsapp-harness.ts";
import { DAY, HOUR } from "./support/reminders.ts";
import { templateParams } from "./support/whatsapp.ts";

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

    it("sends every due reminder even when there are more than one batch", async () => {
      const tenant = await harness.newTenant();
      const phones: string[] = [];
      for (let index = 0; index < 5; index++) {
        phones.push((await schedule(tenant, { startsAt: at(NOW, (3 + index) * DAY) })).phone);
      }

      const summary = await sweep(tenant, { batchSize: 2 });

      expect(summary).toMatchObject({ claimed: 5, sent: 5 });
      for (const phone of phones) expect(harness.client.templatesTo(phone)).toHaveLength(1);
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

    it.each([400, 401, 403, 404])("fails at once after a permanent %i and never retries", async (status) => {
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
      for (const secret of [phone, "573008887766", "8877", token, "Ana", "Beto", "Reservad"]) {
        expect(recorded).not.toContain(secret);
      }
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
