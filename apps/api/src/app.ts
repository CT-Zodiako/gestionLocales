import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ErrorResponse, HealthResponse, MeResponse } from "@gestion/shared";
import { createAgendaRoutes, type AgendaDeps } from "./agenda-routes.ts";
import { createWhatsAppRoutes, type WhatsAppWebhookDeps } from "./whatsapp/webhook-routes.ts";

/** What the API needs from the auth instance; kept narrow so tests can stub it. */
export type AuthDeps = {
  /** Better Auth request handler, mounted at /api/auth/*. */
  handler: (request: Request) => Promise<Response>;
  /** Resolves the session behind a request, or null when there is none. */
  getSession: (headers: Headers) => Promise<{ userId: string } | null>;
};

export type AppDeps = {
  /** Resolves when the database answers; rejects otherwise. */
  pingDatabase: () => Promise<void>;
  auth: AuthDeps;
  /** Loads the signed-in user together with its business, or null. */
  findUserWithBusiness: (userId: string) => Promise<MeResponse | null>;
  /** Agenda data access; the agenda routes (appointments, services, opening hours) exist only when given. */
  agenda?: AgendaDeps;
  /** The WhatsApp webhook; when absent its routes answer 404. It is deliberately not behind the session guard. */
  whatsapp?: WhatsAppWebhookDeps;
};

export type SessionEnv = { Variables: { userId: string } };

const unauthorized = { error: "unauthorized" } satisfies ErrorResponse;

/**
 * Guard for authenticated routes: answers 401 without a valid session and
 * exposes the user id as `c.var.userId` when there is one.
 */
export function createSessionGuard(auth: AuthDeps) {
  return createMiddleware<SessionEnv>(async (c, next) => {
    const session = await auth.getSession(c.req.raw.headers);
    if (!session) return c.json(unauthorized, 401);

    c.set("userId", session.userId);
    await next();
  });
}

export function createApp(deps: AppDeps) {
  const app = new Hono().basePath("/api");
  const requireSession = createSessionGuard(deps.auth);

  app.get("/health", async (c) => {
    try {
      await deps.pingDatabase();
      return c.json({ status: "ok", database: "up" } satisfies HealthResponse, 200);
    } catch {
      return c.json({ status: "degraded", database: "down" } satisfies HealthResponse, 503);
    }
  });

  app.on(["GET", "POST"], "/auth/*", (c) => deps.auth.handler(c.req.raw));

  app.get("/me", requireSession, async (c) => {
    const me = await deps.findUserWithBusiness(c.var.userId);
    if (!me) return c.json(unauthorized, 401);

    return c.json(me satisfies MeResponse, 200);
  });

  if (deps.agenda) {
    const agenda = createAgendaRoutes(
      { agenda: deps.agenda, findUserWithBusiness: deps.findUserWithBusiness },
      requireSession,
    );
    app.route("/appointments", agenda.appointments);
    app.route("/services", agenda.services);
    app.route("/opening-hours", agenda.openingHours);
  }

  // Meta calls the webhook without a session: it authenticates itself (verify token, HMAC signature), and
  // `requireSession` is only attached to the routers above, never globally.
  if (deps.whatsapp) {
    app.route("/whatsapp", createWhatsAppRoutes(deps.whatsapp));
  } else {
    app.all("/whatsapp/*", (c) => c.json({ error: "not_found" } satisfies ErrorResponse, 404));
  }

  return app;
}

export type AppType = ReturnType<typeof createApp>;
