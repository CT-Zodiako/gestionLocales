import { serve } from "@hono/node-server";
import { runMigrations } from "@gestion/db";
import { readApiEnv, type ApiEnv } from "./env.ts";
import { createServer } from "./server.ts";
import { createFetchWhatsAppClient } from "./whatsapp/client.ts";
import { describeError } from "./whatsapp/logger.ts";

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
  ...(env.whatsapp
    ? {
        whatsapp: {
          appSecret: env.whatsapp.appSecret,
          verifyToken: env.whatsapp.verifyToken,
          client: createFetchWhatsAppClient({
            token: env.whatsapp.accessToken,
            apiVersion: env.whatsapp.apiVersion,
            baseUrl: env.whatsapp.apiBaseUrl,
          }),
        },
        ...(env.reminders ? { reminders: { templates: env.reminders.templates } } : {}),
      }
    : {}),
});
console.log(env.whatsapp ? "WhatsApp webhook enabled at /api/whatsapp/webhook" : "WhatsApp webhook disabled (WHATSAPP_* not set)");

if (server.reminders) {
  try {
    await server.reminders.start();
    console.log("Reminders enabled: pg-boss sweeps due reminders every minute");
  } catch (error) {
    // A reminders worker that silently does not run is worse than a refused start.
    console.error(`Reminders worker could not start: ${describeError(error)}`);
    await server.close();
    process.exit(1);
  }
} else {
  console.log("Reminders disabled (set WHATSAPP_TEMPLATE_CONFIRMATION and WHATSAPP_TEMPLATE_REMINDER, with WhatsApp enabled)");
}

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
