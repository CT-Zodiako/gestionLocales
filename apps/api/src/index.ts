import { serve } from "@hono/node-server";
import { runMigrations } from "@gestion/db";
import { readApiEnv, type ApiEnv } from "./env.ts";
import { createServer } from "./server.ts";

let env: ApiEnv;
try {
  env = readApiEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (env.runMigrations) {
  await runMigrations(env.databaseUrl);
  console.log("Migrations applied");
}

const server = createServer({
  databaseUrl: env.databaseUrl,
  authSecret: env.authSecret,
  authUrl: env.authUrl,
});

const httpServer = serve({ fetch: server.app.fetch, port: env.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

function shutdown() {
  httpServer.close(() => {
    void server.close().finally(() => process.exit(0));
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
