import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { sweepReminders } from "../src/reminders/sweep.ts";
import { REMINDERS_SWEEP_QUEUE, createReminderWorker, type ReminderWorker } from "../src/reminders/worker.ts";
import { createServer, type Server } from "../src/server.ts";
import { APP_SECRET, FakeWhatsAppClient, VERIFY_TOKEN } from "./support/whatsapp.ts";
import { TEMPLATES } from "./support/whatsapp-harness.ts";
import { authSecret, authUrl, databaseUrl } from "./support/env.ts";

// The real sweep, wrapped in a spy: every test calls it as usual, one test replaces it to observe the server's wiring.
vi.mock("../src/reminders/sweep.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/reminders/sweep.ts")>();
  return { ...actual, sweepReminders: vi.fn(actual.sweepReminders) };
});

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

  describe("shutdown and logging", () => {
    function captureLogger() {
      const lines: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }> = [];
      const log = (level: string) => (message: string, fields?: Record<string, unknown>) => {
        lines.push({ level, message, fields });
      };
      return { lines, logger: { info: log("info"), warn: log("warn"), error: log("error") } };
    }

    it("raises the stop signal on stop() and waits for the sweep in flight, which can finish its current row", async () => {
      // Given - a sweep that keeps going until it is told to stop, then needs a moment to finish its row
      let started = false;
      let finished = false;
      let received: AbortSignal | undefined;
      const stopping = createReminderWorker({
        connectionString: databaseUrl,
        schema: schemaName,
        pollingIntervalSeconds: 0.5,
        run: async (signal: AbortSignal) => {
          received = signal;
          started = true;
          while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 20));
          await new Promise((resolve) => setTimeout(resolve, 400));
          finished = true;
        },
      });
      await stopping.start();
      await stopping.runNow();
      await until(() => started, 20_000);
      expect(received?.aborted).toBe(false);

      // When
      await stopping.stop();

      // Then
      expect(received?.aborted).toBe(true);
      expect(finished).toBe(true);
    }, 40_000);

    it("the server's own worker hands its stop signal to the sweep: stop() raises it and waits for the sweep in flight", async () => {
      // Given - the server's worker (the production wiring) running a sweep that only ends once told to stop
      const real = (await vi.importActual<typeof import("../src/reminders/sweep.ts")>("../src/reminders/sweep.ts")).sweepReminders;
      let called = false;
      let received: AbortSignal | undefined;
      let finished = false;
      vi.mocked(sweepReminders).mockImplementation(async (_deps, options) => {
        called = true;
        received = options?.signal;
        while (options?.signal && !options.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 20));
        await new Promise((resolve) => setTimeout(resolve, 400));
        finished = true;
        return { claimed: 0, sent: 0, skipped: 0, failed: 0, retried: 0, deferred: 0, errored: 0, paused: false };
      });
      const trigger = new PgBoss({ connectionString: databaseUrl, schema: schemaName, max: 1 });
      try {
        await server.reminders?.start();
        await trigger.start();
        await trigger.send(REMINDERS_SWEEP_QUEUE);
        await until(() => called, 20_000);
        expect(received).toBeInstanceOf(AbortSignal);
        expect(received?.aborted).toBe(false);

        // When
        await server.reminders?.stop();

        // Then
        expect(received?.aborted).toBe(true);
        expect(finished).toBe(true);
      } finally {
        vi.mocked(sweepReminders).mockImplementation(real);
        await server.reminders?.stop();
        await trigger.stop({ graceful: false, close: true });
      }
    }, 40_000);

    it("gives a restarted worker a fresh, unraised signal", async () => {
      const abortedAtStart: boolean[] = [];
      let restarted = false;
      const again = createReminderWorker({
        connectionString: databaseUrl,
        schema: schemaName,
        pollingIntervalSeconds: 0.5,
        run: async (signal: AbortSignal) => {
          // Runs of the first start (a queued sweep it may pick up before it is stopped) do not count.
          if (restarted) abortedAtStart.push(signal.aborted);
        },
      });
      await again.start();
      await again.stop();
      await again.start();
      restarted = true;
      try {
        await again.runNow();
        await until(() => abortedAtStart.length >= 1, 20_000);
      } finally {
        await again.stop();
      }

      expect(abortedAtStart[0]).toBe(false);
    }, 40_000);

    it("logs one info line with the counts for a sweep that did work and nothing for an idle one", async () => {
      // Given - the first sweep is idle, the second one claimed rows and tripped the breaker
      const { lines, logger } = captureLogger();
      const summaries = [
        { claimed: 0, sent: 0, skipped: 0, failed: 0, retried: 0, errored: 0, deferred: 0, paused: false },
        { claimed: 4, sent: 2, skipped: 1, failed: 0, retried: 0, errored: 0, deferred: 1, paused: true },
      ];
      let runs = 0;
      const logging = createReminderWorker({
        connectionString: databaseUrl,
        schema: schemaName,
        pollingIntervalSeconds: 0.5,
        logger,
        run: async () => summaries[runs++],
      });
      await logging.start();

      // When
      try {
        await logging.runNow();
        await until(() => runs >= 1, 20_000);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const linesAfterIdle = lines.length;
        await logging.runNow();
        await until(() => lines.some((line) => line.level === "info"), 20_000);
        await new Promise((resolve) => setTimeout(resolve, 600));

        // Then
        expect(linesAfterIdle).toBe(0);
      } finally {
        await logging.stop();
      }
      const info = lines.filter((line) => line.level === "info");
      expect(info).toHaveLength(1);
      expect(info[0]?.fields).toMatchObject({ claimed: 4, sent: 2, skipped: 1, failed: 0, retried: 0, errored: 0, deferred: 1, paused: true });
      expect(JSON.stringify(info[0])).not.toMatch(/\d{8,}/);
    }, 40_000);

    it("logs nothing for a run that returns no summary", async () => {
      const { lines, logger } = captureLogger();
      let runs = 0;
      const quiet = createReminderWorker({
        connectionString: databaseUrl,
        schema: schemaName,
        pollingIntervalSeconds: 0.5,
        logger,
        run: async () => {
          runs += 1;
        },
      });
      await quiet.start();
      try {
        await quiet.runNow();
        await until(() => runs >= 1, 20_000);
        await new Promise((resolve) => setTimeout(resolve, 600));
      } finally {
        await quiet.stop();
      }

      expect(lines).toEqual([]);
    }, 40_000);
  });
});
