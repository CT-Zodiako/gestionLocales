import { PgBoss } from "pg-boss";
import { consoleLogger, describeError, type WhatsAppLogger } from "../whatsapp/logger.ts";

/** pg-boss queue (and schedule) that triggers a sweep. */
export const REMINDERS_SWEEP_QUEUE = "reminders-sweep";

/** Every minute. */
export const REMINDERS_SWEEP_CRON = "* * * * *";

export interface ReminderWorkerOptions {
  /** Same Postgres as the app: pg-boss keeps its own tables in a separate schema. */
  connectionString: string;
  /** One sweep. Must be safe to run concurrently (the sweep claims rows in the database). */
  run: () => Promise<unknown>;
  logger?: WhatsAppLogger;
  /** pg-boss schema; `pgboss` by default. Tests use a scratch one. */
  schema?: string;
  /** How often the worker polls for a queued sweep, in seconds. */
  pollingIntervalSeconds?: number;
}

export interface ReminderWorker {
  /** Installs/migrates the pg-boss schema, registers the worker and the every-minute schedule. Idempotent. */
  start: () => Promise<void>;
  /** Stops polling, waits for a running sweep (up to 10 s) and closes pg-boss's connections. Idempotent. */
  stop: () => Promise<void>;
  /** Queues one sweep now instead of waiting for the next minute. Requires `start`. */
  runNow: () => Promise<void>;
}

const STOP_TIMEOUT_MS = 10_000;

/** The pg-boss worker that runs `run` every minute inside this process. */
export function createReminderWorker(options: ReminderWorkerOptions): ReminderWorker {
  const logger = options.logger ?? consoleLogger;
  let boss: PgBoss | null = null;

  return {
    async start() {
      if (boss) return;

      const instance = new PgBoss({
        connectionString: options.connectionString,
        application_name: "gestion-reminders",
        max: 3,
        ...(options.schema ? { schema: options.schema } : {}),
      });
      instance.on("error", (error) => logger.error("pg-boss error", { reason: describeError(error) }));

      try {
        await instance.start();
        // A failed sweep is not retried by pg-boss: the next minute's sweep picks the same rows up.
        await instance.createQueue(REMINDERS_SWEEP_QUEUE, { retryLimit: 0, expireInSeconds: 10 * 60 });
        await instance.work(
          REMINDERS_SWEEP_QUEUE,
          { pollingIntervalSeconds: options.pollingIntervalSeconds ?? 5 },
          async () => {
            try {
              await options.run();
            } catch (error) {
              // pg-boss records the failed job; the next minute's sweep picks the same rows up.
              logger.error("reminders sweep failed", { reason: describeError(error) });
              throw error;
            }
          },
        );
        await instance.schedule(REMINDERS_SWEEP_QUEUE, REMINDERS_SWEEP_CRON);
      } catch (error) {
        await instance.stop({ graceful: false, close: true }).catch(() => undefined);
        throw error;
      }
      boss = instance;
    },

    async stop() {
      const instance = boss;
      boss = null;
      if (instance) await instance.stop({ graceful: true, close: true, timeout: STOP_TIMEOUT_MS });
    },

    async runNow() {
      if (!boss) throw new Error("The reminder worker is not started");
      await boss.send(REMINDERS_SWEEP_QUEUE);
    },
  };
}
