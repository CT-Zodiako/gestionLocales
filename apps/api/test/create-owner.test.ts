import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  ensureBusiness,
  findBusinessByName,
  findUserByEmail,
  removeBusinessByName,
  removeUserByEmail,
} from "@gestion/db";
import { meResponseSchema } from "@gestion/shared";
import { createProvisioningAuth } from "../src/auth.ts";
import { createOwner, provisionOwner } from "../src/create-owner.ts";
import { createServer, type Server } from "../src/server.ts";
import { authSecret, authUrl, databaseUrl, uniqueEmail } from "./support/env.ts";

function sessionCookie(response: Response): string | null {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";")[0] ?? "";
    if (pair.includes("session_token")) return pair;
  }
  return null;
}

describe("createOwner re-runs", () => {
  const database = createDb(databaseUrl);
  const auth = createProvisioningAuth({ database: database.db, secret: authSecret, baseURL: authUrl });
  const emails: string[] = [];
  const businessNames: string[] = [];
  let server: Server;

  function track(prefix: string) {
    const email = uniqueEmail(prefix);
    const businessName = `Negocio ${email}`;
    emails.push(email);
    businessNames.push(businessName);
    return { email, businessName };
  }

  beforeAll(() => {
    server = createServer({ databaseUrl, authSecret, authUrl });
  });

  afterAll(async () => {
    for (const email of emails) await removeUserByEmail(database.db, email);
    for (const businessName of businessNames) await removeBusinessByName(database.db, businessName);
    await server.close();
    await database.close();
  });

  describe("when the user exists without a business", () => {
    it("links it to the business and lets it reach /api/me after sign-in", async () => {
      // Given - Arrange: a user left behind by a partial run (no business_id)
      const { email, businessName } = track("unlinked");
      const password = "unlinked-owner-password-123";
      await auth.api.signUpEmail({ body: { email, password, name: "Dueño parcial" } });
      expect((await findUserByEmail(database.db, email))?.businessId).toBeNull();

      // When - Act
      const result = await provisionOwner({
        databaseUrl,
        authSecret,
        authUrl,
        email,
        password,
        name: "Dueño parcial",
        businessName,
      });

      // Then - Assert
      const business = await findBusinessByName(database.db, businessName);
      const user = await findUserByEmail(database.db, email);
      expect(business).not.toBeNull();
      expect(result).toEqual({ status: "linked", userId: user?.id, businessId: business?.id });
      expect(user?.businessId).toBe(business?.id);

      const signIn = await server.app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: authUrl },
        body: JSON.stringify({ email, password }),
      });
      const cookie = sessionCookie(signIn);
      expect(signIn.status).toBe(200);

      const me = await server.app.request("/api/me", { headers: { cookie: cookie ?? "" } });
      expect(me.status).toBe(200);
      expect(meResponseSchema.parse(await me.json()).business).toEqual({
        id: business?.id,
        name: businessName,
      });
    });
  });

  describe("when the user is already linked", () => {
    it("still reports exists and changes nothing", async () => {
      // Given - Arrange
      const { email, businessName } = track("linked");
      const otherBusinessName = `Otro ${businessName}`;
      businessNames.push(otherBusinessName);
      const base = { db: database.db, auth, email, password: "linked-owner-password-123", name: "Dueño" };
      const first = await createOwner({ ...base, businessName });
      expect(first.status).toBe("created");

      // When - Act
      const second = await createOwner({ ...base, businessName: otherBusinessName });

      // Then - Assert
      expect(second).toEqual({ status: "exists", userId: first.userId, businessId: first.businessId });
      expect((await findUserByEmail(database.db, email))?.businessId).toBe(first.businessId);
      expect(await findBusinessByName(database.db, otherBusinessName)).toBeNull();
    });
  });

  describe("when sign-up fails after the business was created", () => {
    it("removes the business this call created and rethrows", async () => {
      // Given - Arrange
      const { email, businessName } = track("short-password");

      // When - Act
      const run = createOwner({
        db: database.db,
        auth,
        email,
        password: "short",
        name: "Dueño",
        businessName,
      });

      // Then - Assert
      await expect(run).rejects.toThrow();
      expect(await findBusinessByName(database.db, businessName)).toBeNull();
      expect(await findUserByEmail(database.db, email)).toBeNull();
    });

    it("keeps a business that already existed before the call", async () => {
      // Given - Arrange
      const { email, businessName } = track("short-password-existing");
      const existing = await ensureBusiness(database.db, businessName);

      // When - Act
      const run = createOwner({
        db: database.db,
        auth,
        email,
        password: "short",
        name: "Dueño",
        businessName,
      });

      // Then - Assert
      await expect(run).rejects.toThrow();
      expect(await findBusinessByName(database.db, businessName)).toEqual({ id: existing.id });
    });
  });
});
