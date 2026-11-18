import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, findUserByEmail, removeBusinessByName, removeUserByEmail } from "@gestion/db";
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
});
