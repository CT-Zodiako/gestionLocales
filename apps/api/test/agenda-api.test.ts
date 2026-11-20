import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listAppointments,
  listOpeningHours,
  listServices,
  removeBusinessWithAgenda,
  removeUserByEmail,
} from "@gestion/db";
import {
  appointmentDetailSchema,
  appointmentSchema,
  errorResponseSchema,
  listAppointmentsResponseSchema,
  listServicesResponseSchema,
  meResponseSchema,
  openingHoursSchema,
  serviceSchema,
} from "@gestion/shared";
import { provisionOwner } from "../src/create-owner.ts";
import { createServer, type Server } from "../src/server.ts";
import { authSecret, authUrl, databaseUrl, uniqueEmail } from "./support/env.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BASE = Date.parse("2031-03-10T14:00:00.000Z");

/** Instant `minute` minutes after the fixed test origin, as an ISO string. */
function at(minute: number): string {
  return new Date(BASE + minute * MINUTE).toISOString();
}

/** Window wide enough to see everything a test books. */
const WIDE = { from: new Date(BASE - 30 * DAY), to: new Date(BASE + 30 * DAY) };

type Tenant = { email: string; businessId: string; cookie: string };

describe("agenda HTTP API", () => {
  let server: Server;
  const tenants: Tenant[] = [];

  beforeAll(() => {
    server = createServer({ databaseUrl, authSecret, authUrl });
  });

  afterAll(async () => {
    for (const tenant of tenants) {
      await removeUserByEmail(server.db, tenant.email);
      await removeBusinessWithAgenda(server.db, tenant.businessId);
    }
    await server.close();
  });

  /** A fresh business with its own owner, already signed in. */
  async function newTenant(): Promise<Tenant> {
    const email = uniqueEmail("agenda");
    const password = "super-secret-password-123";
    await provisionOwner({
      databaseUrl,
      authSecret,
      authUrl,
      email,
      password,
      name: "Dueño",
      businessName: `Agenda API ${randomUUID()}`,
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

  function call(tenant: Tenant | null, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (tenant) headers.cookie = tenant.cookie;
    if (body === undefined) return server.app.request(`/api${path}`, { method, headers });

    headers["content-type"] = "application/json";
    return server.app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) });
  }

  async function newService(tenant: Tenant, durationMinutes = 30) {
    const res = await call(tenant, "POST", "/services", { name: "Corte", durationMinutes });
    expect(res.status).toBe(201);
    return serviceSchema.parse(await res.json());
  }

  function book(tenant: Tenant, serviceId: string, startMinute: number, customerPhone = "3001234567") {
    return call(tenant, "POST", "/appointments", { customerPhone, serviceId, startsAt: at(startMinute) });
  }

  async function bookOk(tenant: Tenant, serviceId: string, startMinute: number, customerPhone?: string) {
    const res = await book(tenant, serviceId, startMinute, customerPhone);
    expect(res.status).toBe(201);
    return appointmentSchema.parse(await res.json());
  }

  /** Everything the business has booked or cancelled, read through the data layer. */
  function stored(tenant: Tenant) {
    return listAppointments(server.db, { businessId: tenant.businessId, ...WIDE });
  }

  async function expectError(res: Response, status: number, error: string) {
    expect(res.status).toBe(status);
    expect(errorResponseSchema.parse(await res.json())).toEqual({ error });
  }

  describe("without a session", () => {
    it("answers 401 on every route and changes nothing", async () => {
      // Given - a business with a service, an appointment and an opening range
      const tenant = await newTenant();
      const service = await newService(tenant);
      const appointment = await bookOk(tenant, service.id, 0);
      const week = { hours: [{ weekday: 1, opensAt: "09:00", closesAt: "17:00" }] };
      expect((await call(tenant, "PUT", "/opening-hours", week)).status).toBe(200);
      const before = await stored(tenant);

      const routes: Array<[string, string, unknown?]> = [
        ["GET", `/appointments?from=${at(-60)}&to=${at(600)}`],
        ["POST", "/appointments", { customerPhone: "3009998888", serviceId: service.id, startsAt: at(300) }],
        ["PATCH", `/appointments/${appointment.id}`, { startsAt: at(120) }],
        ["POST", `/appointments/${appointment.id}/cancel`],
        ["GET", "/services"],
        ["POST", "/services", { name: "Tinte", durationMinutes: 60 }],
        ["GET", "/opening-hours"],
        ["PUT", "/opening-hours", { hours: [] }],
      ];

      for (const [method, path, body] of routes) {
        // When - Act
        const res = await call(null, method, path, body);

        // Then - Assert
        await expectError(res, 401, "unauthorized");
      }

      expect(await stored(tenant)).toEqual(before);
      expect(await listServices(server.db, tenant.businessId)).toHaveLength(1);
      expect(await listOpeningHours(server.db, tenant.businessId)).toHaveLength(1);
    });
  });

  describe("POST /api/appointments", () => {
    it("books the slot, computes endsAt from the service duration and reuses the customer", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant, 45);

      const first = await call(tenant, "POST", "/appointments", {
        customerPhone: "+57 (300) 123-4567",
        customerName: "Ana",
        serviceId: service.id,
        startsAt: at(0),
      });
      const second = await bookOk(tenant, service.id, 60, "573001234567");

      expect(first.status).toBe(201);
      const created = appointmentSchema.parse(await first.json());
      expect(created).toMatchObject({
        serviceId: service.id,
        startsAt: at(0),
        endsAt: at(45),
        status: "booked",
      });
      expect(second.customerId).toBe(created.customerId);

      const listed = await call(tenant, "GET", `/appointments?from=${at(-60)}&to=${at(600)}`);
      const { appointments } = listAppointmentsResponseSchema.parse(await listed.json());
      expect(appointments.map((a) => a.customerPhone)).toEqual(["573001234567", "573001234567"]);
      expect(appointments[0]).toMatchObject({ customerName: "Ana", serviceName: "Corte" });
    });

    it("ignores a business id sent by the client and books in the session's business", async () => {
      const tenant = await newTenant();
      const other = await newTenant();
      const service = await newService(tenant);

      const res = await call(tenant, "POST", "/appointments", {
        customerPhone: "3001234567",
        serviceId: service.id,
        startsAt: at(0),
        businessId: other.businessId,
      });

      expect(res.status).toBe(201);
      expect(await stored(tenant)).toHaveLength(1);
      expect(await stored(other)).toHaveLength(0);
    });

    it("answers 409 slot_taken on overlap, leaving the first appointment unchanged", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      const first = await bookOk(tenant, service.id, 0);
      const before = await stored(tenant);

      const res = await book(tenant, service.id, 15, "3007776666");

      await expectError(res, 409, "slot_taken");
      expect(await stored(tenant)).toEqual(before);
      expect(before[0]?.id).toBe(first.id);
    });

    it("accepts back-to-back appointments", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      await bookOk(tenant, service.id, 0);

      const res = await book(tenant, service.id, 30, "3007776666");

      expect(res.status).toBe(201);
      expect(await stored(tenant)).toHaveLength(2);
    });

    it("lets exactly one of 10 concurrent bookings of the same slot win", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);

      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) => book(tenant, service.id, 0, `30055500${index}0`)),
      );

      const statuses = responses.map((res) => res.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
      for (const res of responses.filter((r) => r.status === 409)) {
        expect(errorResponseSchema.parse(await res.json())).toEqual({ error: "slot_taken" });
      }
      const rows = await stored(tenant);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("booked");
    });

    it("answers only 200, 201 or 409 when moves and creates race for one slot, and exactly one wins", async () => {
      const ROUNDS = 8;
      const MOVERS = 7;
      const CREATORS = 7;
      const target = 1000;

      for (let round = 0; round < ROUNDS; round++) {
        // Given - fresh data: MOVERS booked appointments elsewhere, all about to move into one slot
        const tenant = await newTenant();
        const service = await newService(tenant);
        const movers = [];
        for (let index = 0; index < MOVERS; index++) {
          movers.push(await bookOk(tenant, service.id, index * 60, `30066600${index}0`));
        }

        // When - moves and creates hit the same slot in parallel
        const responses = await Promise.all([
          ...movers.map((mover) => call(tenant, "PATCH", `/appointments/${mover.id}`, { startsAt: at(target) })),
          ...Array.from({ length: CREATORS }, (_, index) => book(tenant, service.id, target, `30077700${index}0`)),
        ]);

        // Then - never a 500; one winner; the slot holds exactly one booked appointment
        const statuses = responses.map((res) => res.status);
        expect(statuses.filter((status) => ![200, 201, 409].includes(status))).toEqual([]);
        expect(statuses.filter((status) => status === 200 || status === 201)).toHaveLength(1);
        for (const res of responses.filter((r) => r.status === 409)) {
          expect(errorResponseSchema.parse(await res.json())).toEqual({ error: "slot_taken" });
        }
        const inSlot = (await stored(tenant)).filter(
          (row) => row.status === "booked" && row.startsAt.toISOString() === at(target),
        );
        expect(inSlot).toHaveLength(1);
      }
    }, 120_000);

    it("answers 404 for a service of another business or an unknown one and creates nothing", async () => {
      const tenant = await newTenant();
      const other = await newTenant();
      const foreign = await newService(other);

      const foreignRes = await book(tenant, foreign.id, 0);
      const unknownRes = await book(tenant, randomUUID(), 0);

      await expectError(foreignRes, 404, "not_found");
      await expectError(unknownRes, 404, "not_found");
      expect(await stored(tenant)).toHaveLength(0);
      expect(await stored(other)).toHaveLength(0);
    });
  });

  describe("PATCH /api/appointments/:id", () => {
    it("moves the appointment keeping its duration", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant, 45);
      const appointment = await bookOk(tenant, service.id, 0);

      const res = await call(tenant, "PATCH", `/appointments/${appointment.id}`, { startsAt: at(120) });

      expect(res.status).toBe(200);
      expect(appointmentSchema.parse(await res.json())).toEqual({
        ...appointment,
        startsAt: at(120),
        endsAt: at(165),
      });
      const rows = await stored(tenant);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.startsAt.toISOString()).toBe(at(120));
    });

    it("lets an appointment shift into a range that only overlaps itself", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      const appointment = await bookOk(tenant, service.id, 0);

      const res = await call(tenant, "PATCH", `/appointments/${appointment.id}`, { startsAt: at(10) });

      expect(res.status).toBe(200);
    });

    it("answers 409 slot_taken when the target slot is occupied and leaves the original unchanged", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      const mover = await bookOk(tenant, service.id, 0);
      await bookOk(tenant, service.id, 60, "3007776666");
      const before = await stored(tenant);

      const res = await call(tenant, "PATCH", `/appointments/${mover.id}`, { startsAt: at(45) });

      await expectError(res, 409, "slot_taken");
      expect(await stored(tenant)).toEqual(before);
    });

    it("answers 404 for a cancelled appointment and an unknown id, changing nothing", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      const appointment = await bookOk(tenant, service.id, 0);
      expect((await call(tenant, "POST", `/appointments/${appointment.id}/cancel`)).status).toBe(200);
      const before = await stored(tenant);

      const cancelled = await call(tenant, "PATCH", `/appointments/${appointment.id}`, { startsAt: at(120) });
      const unknown = await call(tenant, "PATCH", `/appointments/${randomUUID()}`, { startsAt: at(120) });

      await expectError(cancelled, 404, "not_found");
      await expectError(unknown, 404, "not_found");
      expect(await stored(tenant)).toEqual(before);
    });
  });

  describe("POST /api/appointments/:id/cancel", () => {
    it("cancels the appointment and frees its slot", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      const appointment = await bookOk(tenant, service.id, 0);

      const res = await call(tenant, "POST", `/appointments/${appointment.id}/cancel`);

      expect(res.status).toBe(200);
      expect(appointmentSchema.parse(await res.json())).toEqual({ ...appointment, status: "cancelled" });
      expect((await book(tenant, service.id, 0, "3007776666")).status).toBe(201);
    });

    it("answers 404 when cancelling twice", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      const appointment = await bookOk(tenant, service.id, 0);
      await call(tenant, "POST", `/appointments/${appointment.id}/cancel`);

      const res = await call(tenant, "POST", `/appointments/${appointment.id}/cancel`);

      await expectError(res, 404, "not_found");
    });
  });

  describe("business isolation", () => {
    it("hides, and refuses to move or cancel, the appointments of another business", async () => {
      const owner = await newTenant();
      const intruder = await newTenant();
      const service = await newService(owner);
      const appointment = await bookOk(owner, service.id, 0);
      const before = await stored(owner);

      const listed = await call(intruder, "GET", `/appointments?from=${at(-60)}&to=${at(600)}`);
      const moved = await call(intruder, "PATCH", `/appointments/${appointment.id}`, { startsAt: at(120) });
      const cancelled = await call(intruder, "POST", `/appointments/${appointment.id}/cancel`);

      expect(listed.status).toBe(200);
      expect(listAppointmentsResponseSchema.parse(await listed.json())).toEqual({ appointments: [] });
      await expectError(moved, 404, "not_found");
      await expectError(cancelled, 404, "not_found");
      expect(await stored(owner)).toEqual(before);
      expect(before[0]?.status).toBe("booked");
    });

    it("scopes services to the business", async () => {
      const first = await newTenant();
      const second = await newTenant();
      const service = await newService(first);

      const own = await call(first, "GET", "/services");
      const foreign = await call(second, "GET", "/services");

      expect(listServicesResponseSchema.parse(await own.json())).toEqual({ services: [service] });
      expect(listServicesResponseSchema.parse(await foreign.json())).toEqual({ services: [] });
    });
  });

  describe("GET /api/appointments", () => {
    it("lists the half-open window [from, to) ordered by start, cancelled ones included", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      // Booked out of order: [60,90) is cancelled, [0,30) ends exactly at `from`, [90,120) starts exactly at `to`.
      const late = await bookOk(tenant, service.id, 90, "3000000003");
      const cancelled = await bookOk(tenant, service.id, 60, "3000000002");
      const early = await bookOk(tenant, service.id, 0, "3000000001");
      const inside = await bookOk(tenant, service.id, 30, "3000000004");
      await call(tenant, "POST", `/appointments/${cancelled.id}/cancel`);

      const res = await call(tenant, "GET", `/appointments?from=${at(30)}&to=${at(90)}`);

      expect(res.status).toBe(200);
      const { appointments } = listAppointmentsResponseSchema.parse(await res.json());
      expect(appointments.map((a) => [a.id, a.status])).toEqual([
        [inside.id, "booked"],
        [cancelled.id, "cancelled"],
      ]);
      for (const appointment of appointments) appointmentDetailSchema.parse(appointment);
      expect([early.id, late.id]).not.toContain(appointments[0]?.id);
    });

    it("includes an appointment that starts before `from` but is still running", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant, 60);
      const running = await bookOk(tenant, service.id, 0);

      const res = await call(tenant, "GET", `/appointments?from=${at(30)}&to=${at(90)}`);

      const { appointments } = listAppointmentsResponseSchema.parse(await res.json());
      expect(appointments.map((a) => a.id)).toEqual([running.id]);
    });

    it("accepts a range of exactly 62 days", async () => {
      const tenant = await newTenant();

      const res = await call(tenant, "GET", `/appointments?from=${at(0)}&to=${at(62 * 24 * 60)}`);

      expect(res.status).toBe(200);
    });
  });

  describe("input validation", () => {
    it.each([
      ["a non-date", { startsAt: "not-a-date" }],
      ["an impossible date", { startsAt: "2031-02-30T10:00:00Z" }],
      ["a date-time without offset", { startsAt: "2031-03-10T10:00:00" }],
      ["a non-uuid service id", { serviceId: "not-a-uuid" }],
      ["an empty phone", { customerPhone: "" }],
      ["a phone of 7 digits", { customerPhone: "300-1234" }],
      ["a phone of 16 digits", { customerPhone: "+1234567890123456" }],
      ["a phone with letters", { customerPhone: "30012345ab" }],
      ["an empty name", { customerName: "  " }],
    ])("rejects POST /api/appointments with %s and books nothing", async (_label, override) => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      const body = { customerPhone: "3001234567", serviceId: service.id, startsAt: at(0), ...override };

      const res = await call(tenant, "POST", "/appointments", body);

      await expectError(res, 400, "invalid_request");
      expect(await stored(tenant)).toHaveLength(0);
    });

    it.each([
      ["before the year 2000", "1999-12-31T23:59:59Z"],
      ["after the year 2100", "2101-01-01T00:00:00Z"],
      ["an offset instant that is still before 2000", "2000-01-01T00:00:00+05:00"],
    ])("rejects a startsAt %s on create and move, changing nothing", async (_label, startsAt) => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      const appointment = await bookOk(tenant, service.id, 0);
      const before = await stored(tenant);

      const created = await call(tenant, "POST", "/appointments", {
        customerPhone: "3001234567",
        serviceId: service.id,
        startsAt,
      });
      const moved = await call(tenant, "PATCH", `/appointments/${appointment.id}`, { startsAt });

      await expectError(created, 400, "invalid_request");
      await expectError(moved, 400, "invalid_request");
      expect(await stored(tenant)).toEqual(before);
    });

    it("accepts the first and the last instant of the allowed years", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);

      const first = await call(tenant, "POST", "/appointments", {
        customerPhone: "3001234567",
        serviceId: service.id,
        startsAt: "2000-01-01T00:00:00Z",
      });
      const last = await call(tenant, "POST", "/appointments", {
        customerPhone: "3001234567",
        serviceId: service.id,
        startsAt: "2100-12-31T23:59:59Z",
      });

      expect(first.status).toBe(201);
      expect(last.status).toBe(201);
    });

    it("keeps exactly 24 hours when a 24-hour appointment moves, also across a DST change", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant, 24 * 60);
      const appointment = await bookOk(tenant, service.id, 0);
      const dayMs = 24 * 60 * MINUTE;

      // US clocks went forward on 2031-03-09 and back on 2031-11-02.
      for (const target of ["2031-03-08T12:00:00Z", "2031-03-09T05:00:00Z", "2031-11-01T12:00:00Z", "2031-11-02T04:00:00Z"]) {
        const res = await call(tenant, "PATCH", `/appointments/${appointment.id}`, { startsAt: target });

        expect(res.status).toBe(200);
        const moved = appointmentSchema.parse(await res.json());
        expect(moved.startsAt).toBe(new Date(target).toISOString());
        expect(Date.parse(moved.endsAt) - Date.parse(moved.startsAt)).toBe(dayMs);
      }
    });

    it("rejects POST /api/appointments with a body that is not JSON", async () => {
      const tenant = await newTenant();

      const res = await server.app.request("/api/appointments", {
        method: "POST",
        headers: { cookie: tenant.cookie, "content-type": "application/json" },
        body: "{nope",
      });

      await expectError(res, 400, "invalid_request");
    });

    it("rejects PATCH and cancel with a non-uuid id, and PATCH with a bad date, changing nothing", async () => {
      const tenant = await newTenant();
      const service = await newService(tenant);
      const appointment = await bookOk(tenant, service.id, 0);
      const before = await stored(tenant);

      const badId = await call(tenant, "PATCH", "/appointments/not-a-uuid", { startsAt: at(120) });
      const badCancel = await call(tenant, "POST", "/appointments/not-a-uuid/cancel");
      const badDate = await call(tenant, "PATCH", `/appointments/${appointment.id}`, { startsAt: "tomorrow" });

      await expectError(badId, 400, "invalid_request");
      await expectError(badCancel, 400, "invalid_request");
      await expectError(badDate, 400, "invalid_request");
      expect(await stored(tenant)).toEqual(before);
    });

    it.each([
      ["a bad `from`", `from=yesterday&to=${at(60)}`],
      ["a bad `to`", `from=${at(0)}&to=2031-13-01T00:00:00Z`],
      ["a missing `to`", `from=${at(0)}`],
      ["`to` equal to `from`", `from=${at(0)}&to=${at(0)}`],
      ["`to` before `from`", `from=${at(60)}&to=${at(0)}`],
      ["a range over 62 days", `from=${at(0)}&to=${at(62 * 24 * 60 + 1)}`],
    ])("rejects GET /api/appointments with %s", async (_label, query) => {
      const tenant = await newTenant();

      const res = await call(tenant, "GET", `/appointments?${query}`);

      await expectError(res, 400, "invalid_request");
    });

    it.each([
      ["an empty name", { name: "", durationMinutes: 30 }],
      ["a zero duration", { name: "Corte", durationMinutes: 0 }],
      ["a fractional duration", { name: "Corte", durationMinutes: 1.5 }],
      ["a missing duration", { name: "Corte" }],
    ])("rejects POST /api/services with %s and creates nothing", async (_label, body) => {
      const tenant = await newTenant();

      const res = await call(tenant, "POST", "/services", body);

      await expectError(res, 400, "invalid_request");
      expect(await listServices(server.db, tenant.businessId)).toHaveLength(0);
    });

    it.each([
      ["a weekday of 7", { weekday: 7, opensAt: "09:00", closesAt: "17:00" }],
      ["a negative weekday", { weekday: -1, opensAt: "09:00", closesAt: "17:00" }],
      ["closes before opens", { weekday: 2, opensAt: "17:00", closesAt: "09:00" }],
      ["closes at opens", { weekday: 2, opensAt: "09:00", closesAt: "09:00" }],
      ["a malformed time", { weekday: 2, opensAt: "9:00", closesAt: "17:00" }],
    ])("rejects PUT /api/opening-hours with %s and keeps the previous week", async (_label, range) => {
      const tenant = await newTenant();
      const week = { hours: [{ weekday: 1, opensAt: "09:00", closesAt: "17:00" }] };
      expect((await call(tenant, "PUT", "/opening-hours", week)).status).toBe(200);

      const res = await call(tenant, "PUT", "/opening-hours", {
        hours: [{ weekday: 3, opensAt: "10:00", closesAt: "12:00" }, range],
      });

      await expectError(res, 400, "invalid_request");
      const kept = await call(tenant, "GET", "/opening-hours");
      expect(openingHoursSchema.parse(await kept.json())).toEqual(week);
    });
  });

  describe("services", () => {
    it("creates a service and lists it", async () => {
      const tenant = await newTenant();

      const created = await call(tenant, "POST", "/services", { name: " Corte ", durationMinutes: 30 });
      const listed = await call(tenant, "GET", "/services");

      expect(created.status).toBe(201);
      const service = serviceSchema.parse(await created.json());
      expect(service).toEqual({ id: expect.any(String), name: "Corte", durationMinutes: 30, active: true, price: null });
      expect(listed.status).toBe(200);
      expect(listServicesResponseSchema.parse(await listed.json())).toEqual({ services: [service] });
    });
  });

  describe("opening hours", () => {
    it("replaces the whole week on PUT and returns it on GET", async () => {
      const tenant = await newTenant();
      const first = {
        hours: [
          { weekday: 1, opensAt: "09:00", closesAt: "13:00" },
          { weekday: 1, opensAt: "14:00", closesAt: "18:00" },
          { weekday: 6, opensAt: "10:00", closesAt: "14:00" },
        ],
      };
      const second = { hours: [{ weekday: 0, opensAt: "08:30", closesAt: "12:00" }] };

      const putFirst = await call(tenant, "PUT", "/opening-hours", first);
      const getFirst = await call(tenant, "GET", "/opening-hours");
      const putSecond = await call(tenant, "PUT", "/opening-hours", second);
      const getSecond = await call(tenant, "GET", "/opening-hours");

      expect(putFirst.status).toBe(200);
      expect(openingHoursSchema.parse(await putFirst.json())).toEqual(first);
      expect(openingHoursSchema.parse(await getFirst.json())).toEqual(first);
      expect(putSecond.status).toBe(200);
      expect(openingHoursSchema.parse(await getSecond.json())).toEqual(second);
    });

    it("scopes the week to the business and clears it with an empty list", async () => {
      const first = await newTenant();
      const second = await newTenant();
      const week = { hours: [{ weekday: 2, opensAt: "09:00", closesAt: "17:00" }] };
      await call(first, "PUT", "/opening-hours", week);

      const foreign = await call(second, "GET", "/opening-hours");
      const cleared = await call(first, "PUT", "/opening-hours", { hours: [] });

      expect(openingHoursSchema.parse(await foreign.json())).toEqual({ hours: [] });
      expect(openingHoursSchema.parse(await cleared.json())).toEqual({ hours: [] });
    });
  });
});
