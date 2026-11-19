import {
  cancelAppointment,
  cancelUpcomingAppointmentForPhone,
  claimWhatsappMessage,
  completeWhatsappMessage,
  createAppointment,
  createDb,
  createService,
  findAppointment,
  findOwnerWithBusiness,
  findService,
  findBookedAppointmentForPhoneAt,
  findUpcomingAppointmentForPhone,
  findWhatsappChannel,
  listAppointmentDetails,
  listAppointments,
  listOpeningHours,
  listServices,
  listUpcomingAppointmentsForPhone,
  moveAppointment,
  releaseWhatsappMessage,
  setOpeningHours,
  upsertCustomer,
  type AppointmentWriteOptions,
  type Database,
} from "@gestion/db";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { sweepReminders, type ReminderTemplates, type SweepOptions, type SweepSummary } from "./reminders/sweep.ts";
import { createReminderWorker } from "./reminders/worker.ts";
import type { WhatsAppClient } from "./whatsapp/client.ts";
import type { WhatsAppLogger } from "./whatsapp/logger.ts";
import type { WhatsAppWebhookDeps } from "./whatsapp/webhook-routes.ts";

/** Present only when the WhatsApp integration is enabled. */
export type WhatsAppOptions = {
  appSecret: string;
  verifyToken: string;
  /** The real Graph API client in production, a fake in tests. */
  client: WhatsAppClient;
  logger?: WhatsAppLogger;
  now?: () => Date;
};

/** Reminders; they run only together with `whatsapp` (they send through its client and channels). */
export type RemindersOptions = {
  templates: ReminderTemplates;
  /** Clock for scheduling and sweeping; defaults to the WhatsApp clock, then the system clock. */
  now?: () => Date;
  logger?: WhatsAppLogger;
  /** Lease of a claimed reminder in milliseconds; 5 minutes by default. */
  leaseMs?: number;
  /** Where and how often the pg-boss worker runs (tests use a scratch schema). */
  worker?: { schema?: string; pollingIntervalSeconds?: number };
};

export type ServerOptions = {
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
  whatsapp?: WhatsAppOptions;
  reminders?: RemindersOptions;
};

/** Present only when reminders are enabled. */
export type RemindersRuntime = {
  /** One sweep over the due reminders; the worker calls it every minute. */
  sweep: (options?: SweepOptions) => Promise<SweepSummary>;
  /** Starts the pg-boss worker. Never called by `createServer`: the entry point does it. */
  start: () => Promise<void>;
  /** Stops the worker (also done by `close`). */
  stop: () => Promise<void>;
};

export type Server = {
  app: ReturnType<typeof createApp>;
  db: Database;
  /** Undefined when reminders are disabled: nothing is scheduled or sent. */
  reminders?: RemindersRuntime;
  close: () => Promise<void>;
};

function buildWhatsApp(db: Database, options: WhatsAppOptions, write: AppointmentWriteOptions): WhatsAppWebhookDeps {
  return {
    appSecret: options.appSecret,
    verifyToken: options.verifyToken,
    client: options.client,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.now ? { now: options.now } : {}),
    store: {
      findChannel: (phoneNumberId) => findWhatsappChannel(db, phoneNumberId),
      claimMessage: (input) => claimWhatsappMessage(db, input),
      releaseMessage: (wamid) => releaseWhatsappMessage(db, wamid),
      completeMessage: (wamid) => completeWhatsappMessage(db, wamid),
      listServices: (businessId) => listServices(db, businessId),
      findService: (businessId, serviceId) => findService(db, businessId, serviceId),
      listOpeningHours: (businessId) => listOpeningHours(db, businessId),
      listAppointments: (input) => listAppointments(db, input),
      upsertCustomer: (input) => upsertCustomer(db, input),
      createAppointment: (input) => createAppointment(db, input, write),
      findBookedAppointmentForPhoneAt: (input) => findBookedAppointmentForPhoneAt(db, input),
      listUpcomingAppointmentsForPhone: (input) => listUpcomingAppointmentsForPhone(db, input),
      findUpcomingAppointmentForPhone: (input) => findUpcomingAppointmentForPhone(db, input),
      cancelUpcomingAppointmentForPhone: (input) => cancelUpcomingAppointmentForPhone(db, input),
    },
  };
}

/**
 * Wires the real dependencies (database, Better Auth, owner loader) around
 * `createApp`. Tests and `index.ts` share it so both exercise the same wiring.
 */
export function createServer(options: ServerOptions): Server {
  const database = createDb(options.databaseUrl);
  const auth = createAuth({
    database: database.db,
    secret: options.authSecret,
    baseURL: options.authUrl,
  });

  // Reminders need a WhatsApp channel to send through; without it nothing is scheduled.
  const remindersOptions = options.whatsapp ? options.reminders : undefined;
  const now = remindersOptions?.now ?? options.whatsapp?.now ?? (() => new Date());
  const write: AppointmentWriteOptions = remindersOptions ? { scheduleReminders: true, now } : {};
  const reminders = options.whatsapp && remindersOptions ? buildReminders(options, remindersOptions, options.whatsapp, database.db, now) : undefined;

  const app = createApp({
    pingDatabase: database.ping,
    auth: {
      handler: (request) => auth.handler(request),
      getSession: async (headers) => {
        const session = await auth.api.getSession({ headers });
        return session ? { userId: session.user.id } : null;
      },
    },
    findUserWithBusiness: (userId) => findOwnerWithBusiness(database.db, userId),
    agenda: {
      listAppointments: (input) => listAppointmentDetails(database.db, input),
      findService: (businessId, serviceId) => findService(database.db, businessId, serviceId),
      upsertCustomer: (input) => upsertCustomer(database.db, input),
      createAppointment: (input) => createAppointment(database.db, input, write),
      findAppointment: (businessId, appointmentId) => findAppointment(database.db, businessId, appointmentId),
      moveAppointment: (businessId, appointmentId, startsAt, endsAt) =>
        moveAppointment(database.db, businessId, appointmentId, startsAt, endsAt, write),
      cancelAppointment: (businessId, appointmentId) => cancelAppointment(database.db, businessId, appointmentId),
      listServices: (businessId) => listServices(database.db, businessId),
      createService: (input) => createService(database.db, input),
      listOpeningHours: (businessId) => listOpeningHours(database.db, businessId),
      setOpeningHours: (businessId, ranges) => setOpeningHours(database.db, businessId, ranges),
    },
    ...(options.whatsapp ? { whatsapp: buildWhatsApp(database.db, options.whatsapp, write) } : {}),
  });

  return {
    app,
    db: database.db,
    ...(reminders ? { reminders } : {}),
    close: async () => {
      await reminders?.stop();
      await database.close();
    },
  };
}

function buildReminders(
  options: ServerOptions,
  reminders: RemindersOptions,
  whatsapp: WhatsAppOptions,
  db: Database,
  now: () => Date,
): RemindersRuntime {
  const logger = reminders.logger ?? whatsapp.logger;
  const sweep = (sweepOptions?: SweepOptions) =>
    sweepReminders(
      {
        db,
        client: whatsapp.client,
        templates: reminders.templates,
        now,
        ...(logger ? { logger } : {}),
        ...(reminders.leaseMs === undefined ? {} : { leaseMs: reminders.leaseMs }),
      },
      sweepOptions,
    );
  const worker = createReminderWorker({
    connectionString: options.databaseUrl,
    run: (signal) => sweep({ signal }),
    ...(logger ? { logger } : {}),
    ...reminders.worker,
  });
  return { sweep, start: worker.start, stop: worker.stop };
}
