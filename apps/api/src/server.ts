import {
  cancelAppointment,
  createAppointment,
  createDb,
  createService,
  findAppointment,
  findOwnerWithBusiness,
  findService,
  listAppointmentDetails,
  listOpeningHours,
  listServices,
  moveAppointment,
  setOpeningHours,
  upsertCustomer,
  type Database,
} from "@gestion/db";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";

export type ServerOptions = {
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
};

export type Server = {
  app: ReturnType<typeof createApp>;
  db: Database;
  close: () => Promise<void>;
};

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
  });

  return { app, db: database.db, close: database.close };
}
