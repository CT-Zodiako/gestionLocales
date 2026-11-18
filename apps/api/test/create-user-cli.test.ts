import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, findBusinessByName, findUserByEmail, removeBusinessByName, removeUserByEmail } from "@gestion/db";
import { createProvisioningAuth } from "../src/auth.ts";
import { authSecret, authUrl, databaseUrl, uniqueEmail } from "./support/env.ts";

const apiDir = fileURLToPath(new URL("..", import.meta.url));

type CliResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/auth-cli.ts", ...args],
      {
        cwd: apiDir,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          BETTER_AUTH_SECRET: authSecret,
          BETTER_AUTH_URL: authUrl,
        },
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe("auth:create-user CLI", () => {
  const email = uniqueEmail("cli-owner");
  const businessName = `Barbería ${email}`;
  const database = createDb(databaseUrl);

  afterAll(async () => {
    await removeUserByEmail(database.db, email);
    await removeBusinessByName(database.db, businessName);
    await database.close();
  });

  it("creates the owner once and reports the existing user on a re-run", async () => {
    // Given - Arrange
    const args = [
      "--email",
      email,
      "--password",
      "cli-owner-password-123",
      "--name",
      "Dueño CLI",
      "--business",
      businessName,
    ];

    // When - Act
    const first = await runCli(args);
    const second = await runCli(args);

    // Then - Assert
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`Owner created: ${email}`);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`User already exists: ${email}`);

    const user = await findUserByEmail(database.db, email);
    expect(user).not.toBeNull();
    expect(user?.businessId).not.toBeNull();

    const createdId = first.stdout.match(/Business id: (\S+)/)?.[1];
    const repeatedId = second.stdout.match(/Business id: (\S+)/)?.[1];
    expect(createdId).toBe(user?.businessId);
    expect(repeatedId).toBe(createdId);
  }, 60_000);

  it("reports a linked user when an existing user had no business", async () => {
    // Given - Arrange
    const linkedEmail = uniqueEmail("cli-linked");
    const linkedBusiness = `Barbería ${linkedEmail}`;
    const password = "cli-linked-password-123";
    const auth = createProvisioningAuth({ database: database.db, secret: authSecret, baseURL: authUrl });
    try {
      await auth.api.signUpEmail({ body: { email: linkedEmail, password, name: "Dueño CLI" } });

      // When - Act
      const result = await runCli([
        "--email",
        linkedEmail,
        "--password",
        password,
        "--name",
        "Dueño CLI",
        "--business",
        linkedBusiness,
      ]);

      // Then - Assert
      const user = await findUserByEmail(database.db, linkedEmail);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`User linked to business: ${linkedEmail}`);
      expect(result.stdout).toContain(`Business id: ${user?.businessId}`);
      expect(user?.businessId).not.toBeNull();
    } finally {
      await removeUserByEmail(database.db, linkedEmail);
      await removeBusinessByName(database.db, linkedBusiness);
    }
  }, 60_000);

  it("exits 1 with a one-line error and no orphan business when sign-up fails", async () => {
    // Given - Arrange
    const shortEmail = uniqueEmail("cli-short");
    const shortBusiness = `Barbería ${shortEmail}`;
    try {
      // When - Act
      const result = await runCli([
        "--email",
        shortEmail,
        "--password",
        "short",
        "--name",
        "Dueño CLI",
        "--business",
        shortBusiness,
      ]);

      // Then - Assert
      expect(result.code).toBe(1);
      // Better Auth logs its own warning line; the CLI adds exactly one error line and no stack.
      const errorLines = result.stderr.split("\n").filter((line) => line.includes("Could not create the owner:"));
      expect(errorLines).toEqual(["Could not create the owner: Password too short"]);
      expect(result.stderr).not.toContain("    at ");
      expect(result.stdout).toBe("");
      expect(await findBusinessByName(database.db, shortBusiness)).toBeNull();
      expect(await findUserByEmail(database.db, shortEmail)).toBeNull();
    } finally {
      await removeUserByEmail(database.db, shortEmail);
      await removeBusinessByName(database.db, shortBusiness);
    }
  }, 60_000);
});
