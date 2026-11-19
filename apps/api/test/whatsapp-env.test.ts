import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readApiEnv } from "../src/env.ts";
import { databaseUrl } from "./support/env.ts";

const apiDir = fileURLToPath(new URL("..", import.meta.url));
const base = { DATABASE_URL: "postgres://user:pass@db:5432/app" };
const full = {
  ...base,
  WHATSAPP_APP_SECRET: "throwaway-secret",
  WHATSAPP_VERIFY_TOKEN: "throwaway-verify",
  WHATSAPP_TOKEN: "throwaway-token",
};

describe("readApiEnv: WhatsApp", () => {
  it("is disabled when nothing is configured, including empty values as compose passes them", () => {
    expect(readApiEnv(base).whatsapp).toBeUndefined();
    expect(
      readApiEnv({
        ...base,
        WHATSAPP_APP_SECRET: "",
        WHATSAPP_VERIFY_TOKEN: "",
        WHATSAPP_TOKEN: "",
        WHATSAPP_PHONE_NUMBER_ID: "",
        WHATSAPP_API_VERSION: "",
        WHATSAPP_API_BASE_URL: "",
      }).whatsapp,
    ).toBeUndefined();
  });

  it("is disabled when only the optional variables are set", () => {
    expect(readApiEnv({ ...base, WHATSAPP_PHONE_NUMBER_ID: "123", WHATSAPP_API_VERSION: "v22.0" }).whatsapp).toBeUndefined();
  });

  it("reads the full configuration with the documented defaults", () => {
    expect(readApiEnv(full).whatsapp).toEqual({
      appSecret: "throwaway-secret",
      verifyToken: "throwaway-verify",
      accessToken: "throwaway-token",
      apiVersion: "v23.0",
      apiBaseUrl: "https://graph.facebook.com",
    });
  });

  it("reads the optional phone number id, API version and base URL (trailing slash removed)", () => {
    const env = readApiEnv({
      ...full,
      WHATSAPP_PHONE_NUMBER_ID: " 109876543210 ",
      WHATSAPP_API_VERSION: "v24.0",
      WHATSAPP_API_BASE_URL: "http://localhost:9999/",
    });
    expect(env.whatsapp).toMatchObject({ phoneNumberId: "109876543210", apiVersion: "v24.0", apiBaseUrl: "http://localhost:9999" });
  });

  it.each([
    ["WHATSAPP_APP_SECRET", ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_TOKEN"]],
    ["WHATSAPP_VERIFY_TOKEN", ["WHATSAPP_APP_SECRET", "WHATSAPP_TOKEN"]],
    ["WHATSAPP_TOKEN", ["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]],
  ])("refuses a partial configuration with only %s set, naming what is missing", (present, missing) => {
    const read = () => readApiEnv({ ...base, [present]: "throwaway" });

    expect(read).toThrow("Incomplete WhatsApp configuration");
    for (const name of missing) expect(read).toThrow(name);
    expect(read).not.toThrow("throwaway");
  });

  it("refuses an API version or base URL that are malformed", () => {
    expect(() => readApiEnv({ ...full, WHATSAPP_API_VERSION: "23" })).toThrow("WHATSAPP_API_VERSION");
    expect(() => readApiEnv({ ...full, WHATSAPP_API_BASE_URL: "not a url" })).toThrow("WHATSAPP_API_BASE_URL");
    expect(() => readApiEnv({ ...full, WHATSAPP_API_BASE_URL: "ftp://example.com" })).toThrow("WHATSAPP_API_BASE_URL");
  });
});

describe("API startup with a partial WhatsApp configuration", () => {
  it("exits 1 with a clear message and without echoing any value", async () => {
    const result = await new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
      execFile(
        process.execPath,
        ["src/index.ts"],
        { cwd: apiDir, env: { ...process.env, DATABASE_URL: databaseUrl, PORT: "0", WHATSAPP_APP_SECRET: "throwaway-only", WHATSAPP_VERIFY_TOKEN: "", WHATSAPP_TOKEN: "" }, timeout: 20_000 },
        (error, stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr }),
      );
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Incomplete WhatsApp configuration");
    expect(result.stderr).toContain("WHATSAPP_VERIFY_TOKEN");
    expect(result.stderr).not.toContain("throwaway-only");
    expect(result.stdout).not.toContain("API listening");
  }, 30_000);
});
