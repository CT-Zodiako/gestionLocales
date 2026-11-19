import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readApiEnv } from "../src/env.ts";
import { databaseUrl } from "./support/env.ts";

const apiDir = fileURLToPath(new URL("..", import.meta.url));
const base = { DATABASE_URL: "postgres://user:pass@db:5432/app" };
const whatsapp = {
  ...base,
  WHATSAPP_APP_SECRET: "throwaway-secret",
  WHATSAPP_VERIFY_TOKEN: "throwaway-verify",
  WHATSAPP_TOKEN: "throwaway-token",
};
const templates = { WHATSAPP_TEMPLATE_CONFIRMATION: "cita_confirmacion", WHATSAPP_TEMPLATE_REMINDER: "cita_recordatorio" };

describe("readApiEnv: reminders", () => {
  it("are disabled without template names, including empty values as compose passes them", () => {
    expect(readApiEnv(whatsapp).reminders).toBeUndefined();
    expect(
      readApiEnv({ ...whatsapp, WHATSAPP_TEMPLATE_CONFIRMATION: "", WHATSAPP_TEMPLATE_REMINDER: "  ", WHATSAPP_TEMPLATE_LANGUAGE: "" })
        .reminders,
    ).toBeUndefined();
  });

  it("are enabled with WhatsApp and both template names, language es by default", () => {
    expect(readApiEnv({ ...whatsapp, ...templates }).reminders).toEqual({
      templates: { confirmation: "cita_confirmacion", reminder: "cita_recordatorio", language: "es" },
    });
  });

  it("read the template language, trimming blanks", () => {
    const env = readApiEnv({ ...whatsapp, ...templates, WHATSAPP_TEMPLATE_LANGUAGE: " es_CO " });

    expect(env.reminders?.templates.language).toBe("es_CO");
  });

  it("do not change the WhatsApp configuration that was already read", () => {
    expect(readApiEnv({ ...whatsapp, ...templates }).whatsapp).toEqual(readApiEnv(whatsapp).whatsapp);
  });

  it("stay disabled, without error, when both templates are set but WhatsApp is not configured", () => {
    const env = readApiEnv({ ...base, ...templates });

    expect(env.whatsapp).toBeUndefined();
    expect(env.reminders).toBeUndefined();
  });

  it.each([
    ["WHATSAPP_TEMPLATE_CONFIRMATION", "WHATSAPP_TEMPLATE_REMINDER"],
    ["WHATSAPP_TEMPLATE_REMINDER", "WHATSAPP_TEMPLATE_CONFIRMATION"],
  ])("refuse to start with only %s set, naming the missing one and never echoing the value", (present, missing) => {
    const read = (extra: Record<string, string>) => () => readApiEnv({ ...whatsapp, [present]: "valor_privado", ...extra });

    expect(read({})).toThrow("Incomplete reminders configuration");
    expect(read({})).toThrow(missing);
    expect(read({})).not.toThrow("valor_privado");
    // the same rule applies when WhatsApp itself is off
    expect(() => readApiEnv({ ...base, [present]: "valor_privado" })).toThrow("Incomplete reminders configuration");
  });

  it("refuse template names Meta would reject and a malformed language", () => {
    expect(() => readApiEnv({ ...whatsapp, ...templates, WHATSAPP_TEMPLATE_CONFIRMATION: "Cita Confirmación" })).toThrow(
      "WHATSAPP_TEMPLATE_CONFIRMATION",
    );
    expect(() => readApiEnv({ ...whatsapp, ...templates, WHATSAPP_TEMPLATE_REMINDER: "con-guion" })).toThrow("WHATSAPP_TEMPLATE_REMINDER");
    expect(() => readApiEnv({ ...whatsapp, ...templates, WHATSAPP_TEMPLATE_LANGUAGE: "Spanish" })).toThrow("WHATSAPP_TEMPLATE_LANGUAGE");
  });
});

describe("API startup with a partial reminders configuration", () => {
  it("exits 1 with a clear message, without echoing any value and without listening", async () => {
    const result = await new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
      execFile(
        process.execPath,
        ["src/index.ts"],
        {
          cwd: apiDir,
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            PORT: "0",
            WHATSAPP_APP_SECRET: "throwaway-only",
            WHATSAPP_VERIFY_TOKEN: "throwaway-verify-only",
            WHATSAPP_TOKEN: "throwaway-token-only",
            WHATSAPP_TEMPLATE_CONFIRMATION: "cita_privada",
            WHATSAPP_TEMPLATE_REMINDER: "",
          },
          timeout: 20_000,
        },
        (error, stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr }),
      );
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Incomplete reminders configuration");
    expect(result.stderr).toContain("WHATSAPP_TEMPLATE_REMINDER");
    expect(result.stderr).not.toContain("cita_privada");
    expect(result.stdout).not.toContain("API listening");
  }, 30_000);
});
