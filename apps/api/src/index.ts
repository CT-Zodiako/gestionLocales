import { serve } from "@hono/node-server";
import { createDb, runMigrations } from "@gestion/db";
import { createApp } from "./app.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);

if (process.env.RUN_MIGRATIONS === "true") {
  await runMigrations(databaseUrl);
  console.log("Migrations applied");
}

const database = createDb(databaseUrl);
const app = createApp({ pingDatabase: database.ping });

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

function shutdown() {
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
