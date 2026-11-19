import {
  cancelAppointment,
  cancelUpcomingAppointmentForPhone,
  claimWhatsappMessage,
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
  type Database,
} from "@gestion/db";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
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

export type ServerOptions = {
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
  whatsapp?: WhatsAppOptions;
};

export type Server = {
  app: ReturnType<typeof createApp>;
  db: Database;
  close: () => Promise<void>;
};

function buildWhatsApp(db: Database, options: WhatsAppOptions): WhatsAppWebhookDeps {
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
      listServices: (businessId) => listServices(db, businessId),
      findService: (businessId, serviceId) => findService(db, businessId, serviceId),
      listOpeningHours: (businessId) => listOpeningHours(db, businessId),
      listAppointments: (input) => listAppointments(db, input),
      upsertCustomer: (input) => upsertCustomer(db, input),
      createAppointment: (input) => createAppointment(db, input),
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
      createAppointment: (input) => createAppointment(database.db, input),
      findAppointment: (businessId, appointmentId) => findAppointment(database.db, businessId, appointmentId),
      moveAppointment: (businessId, appointmentId, startsAt, endsAt) =>
        moveAppointment(database.db, businessId, appointmentId, startsAt, endsAt),
      cancelAppointment: (businessId, appointmentId) => cancelAppointment(database.db, businessId, appointmentId),
      listServices: (businessId) => listServices(database.db, businessId),
      createService: (input) => createService(database.db, input),
      listOpeningHours: (businessId) => listOpeningHours(database.db, businessId),
      setOpeningHours: (businessId, ranges) => setOpeningHours(database.db, businessId, ranges),
    },
    ...(options.whatsapp ? { whatsapp: buildWhatsApp(database.db, options.whatsapp) } : {}),
  });

  return { app, db: database.db, close: database.close };
}
