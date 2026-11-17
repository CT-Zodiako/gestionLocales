import { Hono } from "hono";
import type { HealthResponse } from "@gestion/shared";

export type AppDeps = {
  /** Resolves when the database answers; rejects otherwise. */
  pingDatabase: () => Promise<void>;
};

export function createApp(deps: AppDeps) {
  const app = new Hono().basePath("/api");

  app.get("/health", async (c) => {
    try {
      await deps.pingDatabase();
      return c.json({ status: "ok", database: "up" } satisfies HealthResponse, 200);
    } catch {
      return c.json({ status: "degraded", database: "down" } satisfies HealthResponse, 503);
    }
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
