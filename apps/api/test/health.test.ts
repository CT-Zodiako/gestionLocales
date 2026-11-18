import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "@gestion/shared";
import { createApp, type AppDeps } from "../src/app.ts";

/** Health does not touch auth or the user loader; stub them. */
const unusedDeps: Pick<AppDeps, "auth" | "findUserWithBusiness"> = {
  auth: {
    handler: async () => new Response(null, { status: 404 }),
    getSession: async () => null,
  },
  findUserWithBusiness: async () => null,
};

describe("GET /api/health", () => {
  it("returns 200 with status ok when the database answers", async () => {
    const app = createApp({ ...unusedDeps, pingDatabase: async () => {} });

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(await res.json());
    expect(body).toEqual({ status: "ok", database: "up" });
  });

  it("returns 503 with status degraded when the database is down", async () => {
    const app = createApp({
      ...unusedDeps,
      pingDatabase: async () => {
        throw new Error("connection refused");
      },
    });

    const res = await app.request("/api/health");

    expect(res.status).toBe(503);
    const body = healthResponseSchema.parse(await res.json());
    expect(body).toEqual({ status: "degraded", database: "down" });
  });

  it("returns 404 for unknown routes", async () => {
    const app = createApp({ ...unusedDeps, pingDatabase: async () => {} });

    const res = await app.request("/api/nope");

    expect(res.status).toBe(404);
  });

  it("keeps /api/health reachable without a session", async () => {
    const app = createApp({ ...unusedDeps, pingDatabase: async () => {} });

    const res = await app.request("/api/health", { headers: {} });

    expect(res.status).toBe(200);
  });
});
