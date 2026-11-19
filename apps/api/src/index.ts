import { serve } from "@hono/node-server";
import { runMigrations } from "@gestion/db";
import { readApiEnv, type ApiEnv } from "./env.ts";
import { createServer } from "./server.ts";
import { createFetchWhatsAppClient } from "./whatsapp/client.ts";

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
      }
    : {}),
});
console.log(env.whatsapp ? "WhatsApp webhook enabled at /api/whatsapp/webhook" : "WhatsApp webhook disabled (WHATSAPP_* not set)");

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
