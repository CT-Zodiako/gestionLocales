import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listServices, removeBusinessWithAgenda, removeUserByEmail } from "@gestion/db";
import {
  appointmentDetailSchema,
  appointmentSchema,
  errorResponseSchema,
  listServicesResponseSchema,
  meResponseSchema,
  serviceSchema,
} from "@gestion/shared";
import { provisionOwner } from "../src/create-owner.ts";
import { createServer, type Server } from "../src/server.ts";
import { authSecret, authUrl, databaseUrl, uniqueEmail } from "./support/env.ts";

type Tenant = { email: string; businessId: string; cookie: string };

const MAX_PRICE = 100_000_000;

describe("service prices and PATCH /api/services/:id", () => {
  let server: Server;
  const tenants: Tenant[] = [];
  let owner: Tenant;
  let stranger: Tenant;

  async function newTenant(): Promise<Tenant> {
    const email = uniqueEmail("price");
    const password = "super-secret-password-123";
    await provisionOwner({
      databaseUrl,
      authSecret,
      authUrl,
      email,
      password,
      name: "Dueño",
      businessName: `Service price ${randomUUID()}`,
    });
    const signIn = await server.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: authUrl },
      body: JSON.stringify({ email, password }),
    });
    const cookie = signIn.headers
      .getSetCookie()
      .map((raw) => raw.split(";")[0] ?? "")
      .find((pair) => pair.includes("session_token"));
    if (signIn.status !== 200 || !cookie) throw new Error("test owner could not sign in");
    const me = await server.app.request("/api/me", { headers: { cookie } });
    const { business } = meResponseSchema.parse(await me.json());
    const tenant = { email, businessId: business.id, cookie };
    tenants.push(tenant);
    return tenant;
  }

  beforeAll(async () => {
    server = createServer({ databaseUrl, authSecret, authUrl });
    owner = await newTenant();
    stranger = await newTenant();
  });

  afterAll(async () => {
    for (const tenant of tenants) {
      await removeUserByEmail(server.db, tenant.email);
      await removeBusinessWithAgenda(server.db, tenant.businessId);
    }
    await server.close();
  });

  function call(tenant: Tenant | null, method: string, path: string, body?: unknown, rawBody?: string) {
    const headers: Record<string, string> = {};
    if (tenant) headers.cookie = tenant.cookie;
    if (rawBody !== undefined) {
      headers["content-type"] = "application/json";
      return server.app.request(`/api${path}`, { method, headers, body: rawBody });
    }
    if (body === undefined) return server.app.request(`/api${path}`, { method, headers });
    headers["content-type"] = "application/json";
    return server.app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) });
  }

  async function createOk(tenant: Tenant, body: Record<string, unknown>) {
    const res = await call(tenant, "POST", "/services", body);
    expect(res.status).toBe(201);
    return serviceSchema.parse(await res.json());
  }

  async function expectError(res: Response, status: number, error: string) {
    expect(res.status).toBe(status);
    expect(errorResponseSchema.parse(await res.json())).toEqual({ error });
  }

  async function listed(tenant: Tenant) {
    const res = await call(tenant, "GET", "/services");
    expect(res.status).toBe(200);
    return listServicesResponseSchema.parse(await res.json()).services;
  }

  describe("creating with a price", () => {
    it("stores and returns a whole-peso price and lists it", async () => {
      const res = await call(owner, "POST", "/services", { name: " Corte ", durationMinutes: 30, price: 25000 });

      expect(res.status).toBe(201);
      const created = serviceSchema.parse(await res.json());
      expect(created).toEqual({ id: expect.any(String), name: "Corte", durationMinutes: 30, active: true, price: 25000 });
      expect(await listed(owner)).toContainEqual(created);
    });

    it("returns price null when none is given, and when null is given explicitly", async () => {
      const without = await createOk(owner, { name: "Sin precio", durationMinutes: 20 });
      const explicit = await createOk(owner, { name: "Precio nulo", durationMinutes: 20, price: null });

      expect(without.price).toBeNull();
      expect(explicit.price).toBeNull();
      const raw = (await (await call(owner, "GET", "/services")).json()) as { services: Array<Record<string, unknown>> };
      expect(raw.services.find((service) => service.id === without.id)).toHaveProperty("price", null);
    });

    it.each([
      ["zero", 0],
      ["the maximum", MAX_PRICE],
      ["a thousand-separated amount", 1234567],
    ])("accepts %s", async (_label, price) => {
      const created = await createOk(owner, { name: "Límite", durationMinutes: 15, price });

      expect(created.price).toBe(price);
    });

    it.each([
      ["a negative price", -1],
      ["a fractional price", 1.5],
      ["a price above the maximum", MAX_PRICE + 1],
      ["a price as a string", "25000"],
      ["a boolean price", true],
      ["an object price", { amount: 1 }],
    ])("rejects %s with 400 and creates nothing", async (_label, price) => {
      const before = await listServices(server.db, owner.businessId);

      const res = await call(owner, "POST", "/services", { name: "Malo", durationMinutes: 30, price });

      await expectError(res, 400, "invalid_request");
      expect(await listServices(server.db, owner.businessId)).toHaveLength(before.length);
    });
  });

  describe("PATCH /api/services/:id", () => {
    it("sets a price and keeps every other field", async () => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30 });

      const res = await call(owner, "PATCH", `/services/${service.id}`, { price: 25000 });

      expect(res.status).toBe(200);
      expect(serviceSchema.parse(await res.json())).toEqual({ ...service, price: 25000 });
      expect((await listed(owner)).find((row) => row.id === service.id)).toEqual({ ...service, price: 25000 });
    });

    it("clears the price with null", async () => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30, price: 25000 });

      const res = await call(owner, "PATCH", `/services/${service.id}`, { price: null });

      expect(res.status).toBe(200);
      expect(serviceSchema.parse(await res.json())).toEqual({ ...service, price: null });
      expect((await listed(owner)).find((row) => row.id === service.id)?.price).toBeNull();
    });

    it("changes the name (trimmed), the duration and the active flag without touching the price", async () => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30, price: 25000 });

      const renamed = await call(owner, "PATCH", `/services/${service.id}`, { name: "  Corte clásico  " });
      const longer = await call(owner, "PATCH", `/services/${service.id}`, { durationMinutes: 45 });
      const off = await call(owner, "PATCH", `/services/${service.id}`, { active: false });
      const on = await call(owner, "PATCH", `/services/${service.id}`, { active: true });

      expect(serviceSchema.parse(await renamed.json())).toEqual({ ...service, name: "Corte clásico" });
      expect(serviceSchema.parse(await longer.json())).toEqual({ ...service, name: "Corte clásico", durationMinutes: 45 });
      expect(serviceSchema.parse(await off.json())).toEqual({ ...service, name: "Corte clásico", durationMinutes: 45, active: false });
      expect(serviceSchema.parse(await on.json())).toEqual({ ...service, name: "Corte clásico", durationMinutes: 45 });
    });

    it("changes several fields at once", async () => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30 });

      const res = await call(owner, "PATCH", `/services/${service.id}`, {
        name: "Tinte",
        durationMinutes: 90,
        price: 120000,
        active: false,
      });

      expect(res.status).toBe(200);
      expect(serviceSchema.parse(await res.json())).toEqual({
        id: service.id,
        name: "Tinte",
        durationMinutes: 90,
        price: 120000,
        active: false,
      });
    });

    it("accepts the price bounds 0 and the maximum", async () => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30 });

      const free = await call(owner, "PATCH", `/services/${service.id}`, { price: 0 });
      const max = await call(owner, "PATCH", `/services/${service.id}`, { price: MAX_PRICE });

      expect(serviceSchema.parse(await free.json()).price).toBe(0);
      expect(serviceSchema.parse(await max.json()).price).toBe(MAX_PRICE);
    });

    it.each([
      ["a negative price", { price: -1 }],
      ["a fractional price", { price: 10.5 }],
      ["a price above the maximum", { price: MAX_PRICE + 1 }],
      ["a string price", { price: "10" }],
      ["an empty name", { name: "" }],
      ["a blank name", { name: "   " }],
      ["a name over 120 characters", { name: "x".repeat(121) }],
      ["a zero duration", { durationMinutes: 0 }],
      ["a duration over a day", { durationMinutes: 1441 }],
      ["a fractional duration", { durationMinutes: 1.5 }],
      ["a non-boolean active", { active: "yes" }],
      ["an empty body", {}],
      ["only unknown fields", { color: "red" }],
      ["a valid field next to an invalid one", { name: "Nuevo", price: -5 }],
    ])("rejects %s with 400 and leaves the service unchanged", async (_label, body) => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30, price: 25000 });

      const res = await call(owner, "PATCH", `/services/${service.id}`, body);

      await expectError(res, 400, "invalid_request");
      expect((await listed(owner)).find((row) => row.id === service.id)).toEqual(service);
    });

    it("rejects a missing or malformed body and an id that is not a uuid with 400", async () => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30, price: 25000 });

      await expectError(await call(owner, "PATCH", `/services/${service.id}`), 400, "invalid_request");
      await expectError(await call(owner, "PATCH", `/services/${service.id}`, undefined, "{nope"), 400, "invalid_request");
      await expectError(await call(owner, "PATCH", "/services/not-a-uuid", { price: 1 }), 400, "invalid_request");
      expect((await listed(owner)).find((row) => row.id === service.id)).toEqual(service);
    });

    it("answers 404 for an unknown id", async () => {
      const res = await call(owner, "PATCH", `/services/${randomUUID()}`, { price: 1000 });

      await expectError(res, 404, "not_found");
    });

    it("answers 404 for a service of another business and changes nothing there", async () => {
      const foreign = await createOk(stranger, { name: "Ajeno", durationMinutes: 30, price: 5000 });

      const res = await call(owner, "PATCH", `/services/${foreign.id}`, { name: "Robado", price: 1, active: false });

      await expectError(res, 404, "not_found");
      expect(await listed(stranger)).toContainEqual(foreign);
      expect((await listed(owner)).some((row) => row.id === foreign.id)).toBe(false);
    });

    it("ignores a businessId or id in the body: the service stays in the session's business", async () => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30 });

      const res = await call(owner, "PATCH", `/services/${service.id}`, {
        businessId: stranger.businessId,
        id: randomUUID(),
        price: 777,
      });

      expect(res.status).toBe(200);
      expect(serviceSchema.parse(await res.json())).toEqual({ ...service, price: 777 });
      expect((await listed(stranger)).some((row) => row.id === service.id)).toBe(false);
    });

    it("answers 401 without a session and changes nothing", async () => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30, price: 25000 });

      const res = await call(null, "PATCH", `/services/${service.id}`, { price: 1 });

      await expectError(res, 401, "unauthorized");
      expect((await listed(owner)).find((row) => row.id === service.id)).toEqual(service);
    });
  });

  describe("existing consumers", () => {
    it("keeps appointment responses exactly as they were (no price field)", async () => {
      const service = await createOk(owner, { name: "Corte", durationMinutes: 30, price: 25000 });
      const startsAt = "2031-03-10T14:00:00.000Z";

      const booked = await call(owner, "POST", "/appointments", { customerPhone: "3001234567", serviceId: service.id, startsAt });
      const listedAppointments = await call(
        owner,
        "GET",
        `/appointments?from=${encodeURIComponent("2031-03-10T00:00:00.000Z")}&to=${encodeURIComponent("2031-03-11T00:00:00.000Z")}`,
      );

      expect(booked.status).toBe(201);
      const appointment = (await booked.json()) as Record<string, unknown>;
      expect(Object.keys(appointment).sort()).toEqual(["customerId", "endsAt", "id", "serviceId", "startsAt", "status"]);
      appointmentSchema.parse(appointment);
      const rows = ((await listedAppointments.json()) as { appointments: Array<Record<string, unknown>> }).appointments;
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
        "customerId",
        "customerName",
        "customerPhone",
        "endsAt",
        "id",
        "serviceId",
        "serviceName",
        "startsAt",
        "status",
      ]);
      appointmentDetailSchema.parse(rows[0]);
    });

    it("keeps accepting the old create body without a price", async () => {
      const res = await call(owner, "POST", "/services", { name: "Clásico", durationMinutes: 30 });

      expect(res.status).toBe(201);
      expect(serviceSchema.parse(await res.json())).toMatchObject({ name: "Clásico", durationMinutes: 30, active: true, price: null });
    });

    it("parses an old response without a price as price null", () => {
      const old = { id: randomUUID(), name: "Corte", durationMinutes: 30, active: true };

      expect(serviceSchema.parse(old)).toEqual({ ...old, price: null });
    });
  });
});
