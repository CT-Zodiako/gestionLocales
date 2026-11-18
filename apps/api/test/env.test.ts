import { describe, expect, it } from "vitest";
import { DEV_AUTH_SECRET, readApiEnv } from "../src/env.ts";

describe("readApiEnv", () => {
  it("reads the auth configuration in production", () => {
    // When - Act
    const env = readApiEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@db:5432/app",
      BETTER_AUTH_SECRET: "a-production-secret-with-32-characters",
      BETTER_AUTH_URL: "https://agenda.example.com",
      PORT: "4000",
      RUN_MIGRATIONS: "true",
    });

    // Then - Assert
    expect(env).toEqual({
      databaseUrl: "postgres://user:pass@db:5432/app",
      authSecret: "a-production-secret-with-32-characters",
      authUrl: "https://agenda.example.com",
      port: 4000,
      runMigrations: true,
    });
  });

  it("refuses to start in production without BETTER_AUTH_SECRET", () => {
    // When - Act
    const read = () =>
      readApiEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://user:pass@db:5432/app" });

    // Then - Assert
    expect(read).toThrow("BETTER_AUTH_SECRET is required when NODE_ENV=production");
  });

  it("falls back to the dev-only secret outside production", () => {
    // When - Act
    const env = readApiEnv({ DATABASE_URL: "postgres://user:pass@localhost:5432/app" });

    // Then - Assert
    expect(env.authSecret).toBe(DEV_AUTH_SECRET);
    expect(env.authUrl).toBe("http://localhost:3000");
    expect(env.port).toBe(3000);
    expect(env.runMigrations).toBe(false);
  });

  it("requires DATABASE_URL", () => {
    // When - Act
    const read = () => readApiEnv({ NODE_ENV: "production", BETTER_AUTH_SECRET: "secret" });

    // Then - Assert
    expect(read).toThrow("DATABASE_URL is required");
  });
});
