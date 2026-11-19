import { randomUUID } from "node:crypto";
import { listRemindersForAppointment, removeUserByEmail } from "@gestion/db";
import { appointmentSchema, meResponseSchema } from "@gestion/shared";
import { provisionOwner } from "../../src/create-owner.ts";
import { authSecret, authUrl, databaseUrl, uniqueEmail } from "./env.ts";
import type { Harness, Tenant, TenantOptions } from "./whatsapp-harness.ts";

export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

/** A WhatsApp tenant of the harness that also has a signed-in owner, to drive the HTTP API. */
export interface ApiTenant {
  tenant: Tenant;
  email: string;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
  /** Raw `POST /api/appointments` answer. */
  book: (startsAt: Date, options?: { phone?: string; name?: string; serviceId?: string }) => Promise<Response>;
  /** Books through the API, expecting success. */
  bookOk: (startsAt: Date, options?: { phone?: string; name?: string; serviceId?: string }) => Promise<{ id: string; endsAt: string }>;
  /** Removes the owner so the harness can delete the business. */
  dispose: () => Promise<void>;
}

/**
 * A harness tenant plus an owner (sharing the business through its name) and a session cookie.
 * Sign-ins are rate limited, so tests create few of these.
 */
export async function createApiTenant(harness: Harness, options: TenantOptions = {}): Promise<ApiTenant> {
  const businessName = options.name ?? `Reminders ${randomUUID()}`;
  const tenant = await harness.newTenant({ ...options, name: businessName });
  const email = uniqueEmail("reminders");
  const password = "super-secret-password-123";
  await provisionOwner({ databaseUrl, authSecret, authUrl, email, password, name: "Dueño", businessName });

  const signIn = await harness.server.app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: authUrl },
    body: JSON.stringify({ email, password }),
  });
  const cookie = signIn.headers
    .getSetCookie()
    .map((raw) => raw.split(";")[0] ?? "")
    .find((pair) => pair.includes("session_token"));
  if (signIn.status !== 200 || !cookie) throw new Error("test owner could not sign in");
  const me = meResponseSchema.parse(await (await harness.server.app.request("/api/me", { headers: { cookie } })).json());
  if (me.business.id !== tenant.businessId) throw new Error("owner is not linked to the tenant business");

  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { cookie };
    if (body === undefined) return harness.server.app.request(`/api${path}`, { method, headers });
    headers["content-type"] = "application/json";
    return harness.server.app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) });
  };
  const bookRequest = async (startsAt: Date, bookOptions: { phone?: string; name?: string; serviceId?: string } = {}) =>
    call("POST", "/appointments", {
      customerPhone: bookOptions.phone ?? "573001234567",
      ...(bookOptions.name === undefined ? {} : { customerName: bookOptions.name }),
      serviceId: bookOptions.serviceId ?? tenant.serviceIds[0],
      startsAt: startsAt.toISOString(),
    });

  return {
    tenant,
    email,
    call,
    book: bookRequest,
    bookOk: async (startsAt, bookOptions) => {
      const res = await bookRequest(startsAt, bookOptions);
      if (res.status !== 201) throw new Error(`booking answered ${res.status}`);
      return appointmentSchema.parse(await res.json());
    },
    dispose: () => removeUserByEmail(harness.server.db, email),
  };
}

/** The reminders stored for an appointment, as plain comparable objects. */
export async function remindersOf(harness: Harness, appointmentId: string) {
  const rows = await listRemindersForAppointment(harness.server.db, appointmentId);
  return rows.map((row) => ({
    kind: row.kind,
    status: row.status,
    dueAt: row.dueAt.toISOString(),
    attempts: row.attempts,
  }));
}
