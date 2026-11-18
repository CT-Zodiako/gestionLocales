import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUserByEmail, removeBusinessByName, removeUserByEmail } from "@gestion/db";
import { errorResponseSchema, meResponseSchema } from "@gestion/shared";
import { createServer, type Server } from "../src/server.ts";
import { provisionOwner } from "../src/create-owner.ts";
import { authSecret, authUrl, databaseUrl, uniqueEmail } from "./support/env.ts";

/** Extracts the session cookie (name=value) from a Better Auth response. */
function sessionCookie(response: Response): string | null {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";")[0] ?? "";
    if (pair.includes("session_token")) return pair;
  }
  return null;
}

function postJson(app: Server["app"], path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: authUrl, ...headers },
    body: JSON.stringify(body),
  });
}

describe("session and owner endpoints", () => {
  let server: Server;
  const email = uniqueEmail("sign-in");
  const password = "super-secret-password-123";
  const name = "Dueño de prueba";
  const businessName = `Peluquería ${email}`;

  beforeAll(async () => {
    server = createServer({ databaseUrl, authSecret, authUrl });
    await provisionOwner({ databaseUrl, authSecret, authUrl, email, password, name, businessName });
  });

  afterAll(async () => {
    await removeUserByEmail(server.db, email);
    await removeBusinessByName(server.db, businessName);
    await server.close();
  });

  it("rejects GET /api/me without a session cookie", async () => {
    // When - Act
    const res = await server.app.request("/api/me");

    // Then - Assert
    expect(res.status).toBe(401);
    expect(errorResponseSchema.parse(await res.json())).toEqual({ error: "unauthorized" });
  });

  it("signs in with the right password and returns the user and business", async () => {
    // When - Act
    const signIn = await postJson(server.app, "/auth/sign-in/email", { email, password });
    const cookie = sessionCookie(signIn);

    // Then - Assert
    expect(signIn.status).toBe(200);
    expect(cookie).not.toBeNull();

    const me = await server.app.request("/api/me", { headers: { cookie: cookie ?? "" } });
    expect(me.status).toBe(200);
    const body = meResponseSchema.parse(await me.json());
    expect(body).toEqual({
      user: { id: expect.any(String), email, name },
      business: { id: expect.any(String), name: businessName },
    });
  });

  it("rejects a wrong password without issuing a cookie", async () => {
    // When - Act
    const res = await postJson(server.app, "/auth/sign-in/email", { email, password: "wrong-password" });

    // Then - Assert
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeNull();
  });

  it("rejects public email sign-up and creates no user", async () => {
    // Given - Arrange
    const newEmail = uniqueEmail("walk-in");

    // When - Act
    const res = await postJson(server.app, "/auth/sign-up/email", {
      email: newEmail,
      password: "another-secret-password-123",
      name: "Intruso",
    });

    // Then - Assert
    expect(res.status).toBe(400);
    expect(await findUserByEmail(server.db, newEmail)).toBeNull();
  });

  it("signs out and rejects GET /api/me afterwards", async () => {
    // Given - Arrange
    const signIn = await postJson(server.app, "/auth/sign-in/email", { email, password });
    const cookie = sessionCookie(signIn);
    expect(signIn.status).toBe(200);
    expect(cookie).not.toBeNull();

    // When - Act
    const signOut = await postJson(server.app, "/auth/sign-out", {}, { cookie: cookie ?? "" });

    // Then - Assert
    expect(signOut.status).toBe(200);
    const me = await server.app.request("/api/me", { headers: { cookie: cookie ?? "" } });
    expect(me.status).toBe(401);
  });
});
