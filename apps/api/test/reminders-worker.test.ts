import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAppointment,
  createDb,
  createService,
  ensureBusiness,
  linkWhatsappChannel,
  listRemindersForAppointment,
  removeBusinessWithAgenda,
  sql,
  upsertCustomer,
} from "@gestion/db";
import { REMINDERS_SWEEP_QUEUE, createReminderWorker, type ReminderWorker } from "../src/reminders/worker.ts";
import { createServer, type Server } from "../src/server.ts";
import { APP_SECRET, FakeWhatsAppClient, VERIFY_TOKEN } from "./support/whatsapp.ts";
import { TEMPLATES } from "./support/whatsapp-harness.ts";
import { authSecret, authUrl, databaseUrl } from "./support/env.ts";

const DAY = 24 * 60 * 60_000;

async function until(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the condition");
}

/** pg-boss against the real test database, in a scratch schema that is dropped afterwards. */
describe("reminders worker (pg-boss integration)", () => {
  const schemaName = `pgboss_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const database = createDb(databaseUrl);
  const client = new FakeWhatsAppClient();
  let server: Server;
  let worker: ReminderWorker | undefined;
  let businessId = "";

  beforeAll(() => {
    server = createServer({
      databaseUrl,
      authSecret,
      authUrl,
      whatsapp: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, client },
      reminders: { templates: TEMPLATES, worker: { schema: schemaName, pollingIntervalSeconds: 0.5 } },
    });
  });

  afterAll(async () => {
    await worker?.stop();
    await server.close();
    if (businessId) await removeBusinessWithAgenda(database.db, businessId);
    await database.db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`));
    await database.close();
  });

  it("starts, runs a queued sweep that sends a due reminder through the fake client, and stops", async () => {
    // Given - a real business with a number and an appointment three days away, booked with the real clock
    const business = await ensureBusiness(database.db, `Worker ${randomUUID()}`);
    businessId = business.id;
    const phoneNumberId = `3${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
    await linkWhatsappChannel(database.db, business.id, phoneNumberId);
    const service = await createService(database.db, { businessId: business.id, name: "Corte", durationMinutes: 30 });
    const customer = await upsertCustomer(database.db, { businessId: business.id, phone: "573004445566", name: "Ana" });
    const startsAt = new Date(Date.now() + 3 * DAY);
    const appointment = await createAppointment(
      database.db,
      { businessId: business.id, customerId: customer.id, serviceId: service.id, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) },
      { scheduleReminders: true },
    );

    // The server's own sweep would also pick up other tests' rows, so the worker under test runs a sweep scoped to this business.
    worker = createReminderWorker({
      connectionString: databaseUrl,
      schema: schemaName,
      pollingIntervalSeconds: 0.5,
      run: () => server.reminders?.sweep({ businessIds: [business.id] }) ?? Promise.resolve(),
    });

    // When
    await worker.start();
    await worker.start(); // idempotent
    await worker.runNow();
    await until(async () => (await listRemindersForAppointment(database.db, appointment.id)).some((row) => row.status === "sent"), 20_000);
    await worker.stop();
    await worker.stop(); // idempotent

    // Then
    expect(client.templates.filter((entry) => entry.phoneNumberId === phoneNumberId)).toHaveLength(1);
    const rows = await listRemindersForAppointment(database.db, appointment.id);
    expect(rows.map((row) => `${row.kind}:${row.status}`)).toEqual(["confirmation:sent", "reminder_24h:pending"]);
    expect(REMINDERS_SWEEP_QUEUE).toBe("reminders-sweep");
  }, 40_000);

  it("registers the every-minute schedule in its own schema, not in the application's tables", async () => {
    const check = await database.db.execute(
      sql.raw(`select cron from "${schemaName}".schedule where name = '${REMINDERS_SWEEP_QUEUE}'`),
    );

    expect([...check].map((row) => row.cron)).toEqual(["* * * * *"]);
  });

  it("can be restarted against an existing schema (queue and schedule are created idempotently)", async () => {
    let runs = 0;
    const again = createReminderWorker({
      connectionString: databaseUrl,
      schema: schemaName,
      pollingIntervalSeconds: 0.5,
      run: async () => {
        runs += 1;
      },
    });

    await again.start();
    await again.stop();
    await again.start();
    try {
      await again.runNow();
      await until(() => runs >= 1, 20_000);
    } finally {
      await again.stop();
    }

    expect(runs).toBeGreaterThanOrEqual(1);
  }, 40_000);

  it("refuses runNow before start", async () => {
    const idle = createReminderWorker({ connectionString: databaseUrl, schema: schemaName, run: async () => undefined });

    await expect(idle.runNow()).rejects.toThrow("not started");
    await idle.stop(); // stopping a worker that never started is a no-op
  });
});
