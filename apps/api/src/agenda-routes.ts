import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { SlotTakenError, type schema } from "@gestion/db";
import type {
  cancelAppointment,
  createAppointment,
  createService,
  findAppointment,
  findService,
  listAppointmentDetails,
  listOpeningHours,
  listServices,
  moveAppointment,
  setOpeningHours,
  upsertCustomer,
} from "@gestion/db";
import {
  APPOINTMENT_STATUS,
  appointmentIdParamSchema,
  createAppointmentBodySchema,
  createServiceBodySchema,
  listAppointmentsQuerySchema,
  moveAppointmentBodySchema,
  openingHoursSchema,
  type AppointmentDetailResponse,
  type AppointmentResponse,
  type ErrorResponse,
  type ListAppointmentsResponse,
  type ListServicesResponse,
  type MeResponse,
  type OpeningHoursResponse,
  type ServiceResponse,
} from "@gestion/shared";
import type { SessionEnv } from "./app.ts";

/** A data-layer function with its leading `db` argument already bound. */
type Bound<F> = F extends (db: never, ...args: infer Args) => infer Result ? (...args: Args) => Result : never;

/** Agenda data access the routes need; `server.ts` binds each one to the database. */
export type AgendaDeps = {
  listAppointments: Bound<typeof listAppointmentDetails>;
  findAppointment: Bound<typeof findAppointment>;
  findService: Bound<typeof findService>;
  upsertCustomer: Bound<typeof upsertCustomer>;
  createAppointment: Bound<typeof createAppointment>;
  moveAppointment: Bound<typeof moveAppointment>;
  cancelAppointment: Bound<typeof cancelAppointment>;
  listServices: Bound<typeof listServices>;
  createService: Bound<typeof createService>;
  listOpeningHours: Bound<typeof listOpeningHours>;
  setOpeningHours: Bound<typeof setOpeningHours>;
};

export type AgendaRoutesDeps = {
  agenda: AgendaDeps;
  /** Same loader as GET /api/me: the signed-in user's business is the only source of `business_id`. */
  findUserWithBusiness: (userId: string) => Promise<MeResponse | null>;
};

type AgendaEnv = { Variables: SessionEnv["Variables"] & { businessId: string } };

const invalidRequest = { error: "invalid_request" } satisfies ErrorResponse;
const notFound = { error: "not_found" } satisfies ErrorResponse;
const slotTaken = { error: "slot_taken" } satisfies ErrorResponse;
const unauthorized = { error: "unauthorized" } satisfies ErrorResponse;

type Parsed<T> = { ok: true; data: T } | { ok: false };

/** What `parse` needs from a Zod schema (apps/api does not depend on zod itself). */
type Schema<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
};

function parse<T>(schema: Schema<T>, input: unknown): Parsed<T> {
  const result = schema.safeParse(input);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}

/** Request body as JSON; undefined when it is missing or malformed (the schema then rejects it). */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

type AppointmentFields = Pick<
  schema.Appointment,
  "id" | "customerId" | "serviceId" | "startsAt" | "endsAt" | "status"
>;

function toAppointment(row: AppointmentFields): AppointmentResponse {
  return {
    id: row.id,
    customerId: row.customerId,
    serviceId: row.serviceId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
  };
}

function toService(row: schema.Service): ServiceResponse {
  return { id: row.id, name: row.name, durationMinutes: row.durationMinutes, active: row.active };
}

/** `time` columns come back as `HH:MM:SS`; the API speaks `HH:MM`. */
function toOpeningHours(rows: schema.OpeningHour[]): OpeningHoursResponse {
  return {
    hours: rows.map((row) => ({
      weekday: row.weekday,
      opensAt: row.opensAt.slice(0, 5),
      closesAt: row.closesAt.slice(0, 5),
    })),
  };
}

/**
 * Guard for every agenda route: requires a session (via `requireSession`) and exposes the
 * session user's business as `c.var.businessId`. Nothing the client sends can change it.
 */
function createBusinessGuard(deps: AgendaRoutesDeps) {
  return createMiddleware<AgendaEnv>(async (c, next) => {
    const me = await deps.findUserWithBusiness(c.var.userId);
    if (!me) return c.json(unauthorized, 401);

    c.set("businessId", me.business.id);
    await next();
  });
}

type SessionGuard = ReturnType<typeof createMiddleware<SessionEnv>>;

function createGuardedRoutes(deps: AgendaRoutesDeps, requireSession: SessionGuard) {
  const routes = new Hono<AgendaEnv>();
  routes.use("*", requireSession, createBusinessGuard(deps));
  return routes;
}

function createAppointmentRoutes(deps: AgendaRoutesDeps, requireSession: SessionGuard) {
  const { agenda } = deps;
  const routes = createGuardedRoutes(deps, requireSession);

  routes.get("/", async (c) => {
    const query = parse(listAppointmentsQuerySchema, { from: c.req.query("from"), to: c.req.query("to") });
    if (!query.ok) return c.json(invalidRequest, 400);

    const rows = await agenda.listAppointments({
      businessId: c.var.businessId,
      from: new Date(query.data.from),
      to: new Date(query.data.to),
    });
    const appointments = rows.map(
      (row): AppointmentDetailResponse => ({
        ...toAppointment(row),
        customerPhone: row.customerPhone,
        customerName: row.customerName,
        serviceName: row.serviceName,
      }),
    );
    return c.json({ appointments } satisfies ListAppointmentsResponse, 200);
  });

  routes.post("/", async (c) => {
    const body = parse(createAppointmentBodySchema, await readJson(c));
    if (!body.ok) return c.json(invalidRequest, 400);

    const businessId = c.var.businessId;
    const service = await agenda.findService(businessId, body.data.serviceId);
    if (!service) return c.json(notFound, 404);

    const customer = await agenda.upsertCustomer({
      businessId,
      phone: body.data.customerPhone,
      name: body.data.customerName ?? null,
    });
    const startsAt = new Date(body.data.startsAt);
    const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

    try {
      const appointment = await agenda.createAppointment({
        businessId,
        customerId: customer.id,
        serviceId: service.id,
        startsAt,
        endsAt,
      });
      return c.json(toAppointment(appointment) satisfies AppointmentResponse, 201);
    } catch (error) {
      if (error instanceof SlotTakenError) return c.json(slotTaken, 409);
      throw error;
    }
  });

  routes.patch("/:id", async (c) => {
    const params = parse(appointmentIdParamSchema, c.req.param());
    const body = parse(moveAppointmentBodySchema, await readJson(c));
    if (!params.ok || !body.ok) return c.json(invalidRequest, 400);

    const current = await agenda.findAppointment(c.var.businessId, params.data.id);
    if (!current || current.status !== APPOINTMENT_STATUS.BOOKED) return c.json(notFound, 404);

    // The end is computed from epoch milliseconds, so the duration is kept exactly (no timezone or DST maths).
    const durationMs = current.endsAt.getTime() - current.startsAt.getTime();
    const startsAt = new Date(body.data.startsAt);
    const endsAt = new Date(startsAt.getTime() + durationMs);

    try {
      const moved = await agenda.moveAppointment(c.var.businessId, params.data.id, startsAt, endsAt);
      if (!moved) return c.json(notFound, 404);
      return c.json(toAppointment(moved) satisfies AppointmentResponse, 200);
    } catch (error) {
      if (error instanceof SlotTakenError) return c.json(slotTaken, 409);
      throw error;
    }
  });

  routes.post("/:id/cancel", async (c) => {
    const params = parse(appointmentIdParamSchema, c.req.param());
    if (!params.ok) return c.json(invalidRequest, 400);

    const cancelled = await agenda.cancelAppointment(c.var.businessId, params.data.id);
    if (!cancelled) return c.json(notFound, 404);
    return c.json(toAppointment(cancelled) satisfies AppointmentResponse, 200);
  });

  return routes;
}

function createServiceRoutes(deps: AgendaRoutesDeps, requireSession: SessionGuard) {
  const { agenda } = deps;
  const routes = createGuardedRoutes(deps, requireSession);

  routes.get("/", async (c) => {
    const rows = await agenda.listServices(c.var.businessId);
    return c.json({ services: rows.map(toService) } satisfies ListServicesResponse, 200);
  });

  routes.post("/", async (c) => {
    const body = parse(createServiceBodySchema, await readJson(c));
    if (!body.ok) return c.json(invalidRequest, 400);

    const created = await agenda.createService({ businessId: c.var.businessId, ...body.data });
    return c.json(toService(created) satisfies ServiceResponse, 201);
  });

  return routes;
}

function createOpeningHoursRoutes(deps: AgendaRoutesDeps, requireSession: SessionGuard) {
  const { agenda } = deps;
  const routes = createGuardedRoutes(deps, requireSession);

  routes.get("/", async (c) => {
    const rows = await agenda.listOpeningHours(c.var.businessId);
    return c.json(toOpeningHours(rows) satisfies OpeningHoursResponse, 200);
  });

  routes.put("/", async (c) => {
    const body = parse(openingHoursSchema, await readJson(c));
    if (!body.ok) return c.json(invalidRequest, 400);

    const saved = await agenda.setOpeningHours(c.var.businessId, body.data.hours);
    const ordered = [...saved].sort((a, b) => a.weekday - b.weekday || a.opensAt.localeCompare(b.opensAt));
    return c.json(toOpeningHours(ordered) satisfies OpeningHoursResponse, 200);
  });

  return routes;
}

/** The agenda API (appointments, services, opening hours); every route sits behind the session guard. */
export function createAgendaRoutes(deps: AgendaRoutesDeps, requireSession: SessionGuard) {
  return {
    appointments: createAppointmentRoutes(deps, requireSession),
    services: createServiceRoutes(deps, requireSession),
    openingHours: createOpeningHoursRoutes(deps, requireSession),
  };
}
