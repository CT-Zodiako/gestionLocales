import { createDb, findOwnerWithBusiness, type Database } from "@gestion/db";
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
  });

  return { app, db: database.db, close: database.close };
}
