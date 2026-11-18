import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * E2E against the Docker stack: `docker compose up -d --build`, then `pnpm e2e`.
 * The browser timezone is pinned so "today" and the seeded hours are deterministic.
 */
export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // Traces of failures go to the system temp dir, so a run never leaves artifacts in the repo.
  outputDir: join(tmpdir(), "gestion-e2e-results"),
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    locale: "es-CO",
    timezoneId: "America/Bogota",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
