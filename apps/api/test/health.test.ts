import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "@gestion/shared";
import { createApp } from "../src/app.ts";

describe("GET /api/health", () => {
  it("returns 200 with status ok when the database answers", async () => {
    const app = createApp({ pingDatabase: async () => {} });

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(await res.json());
    expect(body).toEqual({ status: "ok", database: "up" });
  });

  it("returns 503 with status degraded when the database is down", async () => {
    const app = createApp({
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
    const app = createApp({ pingDatabase: async () => {} });

    const res = await app.request("/api/nope");

    expect(res.status).toBe(404);
  });
});
