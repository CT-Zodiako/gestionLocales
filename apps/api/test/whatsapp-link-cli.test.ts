import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, findWhatsappChannel, removeBusinessWithAgenda, removeUserByEmail } from "@gestion/db";
import { provisionOwner } from "../src/create-owner.ts";
import { authSecret, authUrl, databaseUrl, uniqueEmail } from "./support/env.ts";

const apiDir = fileURLToPath(new URL("..", import.meta.url));

type CliResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/whatsapp-link-cli.ts", ...args],
      { cwd: apiDir, env: { ...process.env, DATABASE_URL: databaseUrl, WHATSAPP_PHONE_NUMBER_ID: "", ...extraEnv } },
      (error, stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr }),
    );
  });
}

describe("whatsapp:link CLI", () => {
  const database = createDb(databaseUrl);
  const owners: Array<{ email: string; businessId: string }> = [];

  async function newOwner() {
    const email = uniqueEmail("wa-link");
    const created = await provisionOwner({
      databaseUrl,
      authSecret,
      authUrl,
      email,
      password: "wa-link-password-123",
      name: "Dueño",
      businessName: `WhatsApp link ${email}`,
    });
    owners.push({ email, businessId: created.businessId ?? "" });
    return { email, businessId: created.businessId ?? "" };
  }

  const phoneNumberId = () => `3${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;

  afterAll(async () => {
    for (const owner of owners) {
      await removeUserByEmail(database.db, owner.email);
      await removeBusinessWithAgenda(database.db, owner.businessId);
    }
    await database.close();
  });

  it("registers the phone number id for the owner's business and is idempotent", async () => {
    const owner = await newOwner();
    const id = phoneNumberId();

    const first = await runCli(["--email", owner.email, "--phone-number-id", id]);
    const second = await runCli(["--email", owner.email, "--phone-number-id", id]);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`WhatsApp number linked: ${id}`);
    expect(first.stdout).toContain(`Business id: ${owner.businessId}`);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`WhatsApp number already linked: ${id}`);
    expect(second.stdout).toContain(`Business id: ${owner.businessId}`);
    expect((await findWhatsappChannel(database.db, id))?.businessId).toBe(owner.businessId);
  }, 60_000);

  it("refuses to link a phone number id that belongs to another business, leaving it untouched", async () => {
    const [one, two] = [await newOwner(), await newOwner()];
    const id = phoneNumberId();
    await runCli(["--email", one.email, "--phone-number-id", id]);

    const result = await runCli(["--email", two.email, "--phone-number-id", id]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already linked to another business");
    expect(result.stdout).toBe("");
    expect((await findWhatsappChannel(database.db, id))?.businessId).toBe(one.businessId);
  }, 60_000);

  it("falls back to AUTH_EMAIL and WHATSAPP_PHONE_NUMBER_ID", async () => {
    const owner = await newOwner();
    const id = phoneNumberId();

    const result = await runCli([], { AUTH_EMAIL: owner.email, WHATSAPP_PHONE_NUMBER_ID: id });

    expect(result.code).toBe(0);
    expect((await findWhatsappChannel(database.db, id))?.businessId).toBe(owner.businessId);
  }, 60_000);

  it.each([
    ["an unknown owner", () => ["--email", uniqueEmail("nobody"), "--phone-number-id", "123456789012345"], "No owner found"],
    ["a missing email", () => ["--phone-number-id", "123456789012345"], "Missing value: --email"],
    ["a missing phone number id", () => ["--email", "someone@example.com"], "Missing value: --phone-number-id"],
    ["a phone number id that is not digits", () => ["--email", "someone@example.com", "--phone-number-id", "12ab"], "phone number id"],
  ])("exits 1 with a one-line message for %s", async (_name, args, message) => {
    const result = await runCli(args());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("    at ");
    expect(result.stdout).toBe("");
  }, 60_000);

  it("prints usage with --help", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pnpm whatsapp:link");
  });
});
