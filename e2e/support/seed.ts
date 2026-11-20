import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type APIRequestContext } from "@playwright/test";
import { addDays, instant, mondayOf, today } from "./dates.ts";
import { compose } from "./stack.ts";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const PG_USER = process.env.POSTGRES_USER ?? "gestion";
const PG_DB = process.env.POSTGRES_DB ?? "gestion";

/** What the specs need to know about the seeded business. Exported through `process.env.E2E_STATE`. */
export type E2eState = {
  email: string;
  password: string;
  businessId: string;
  businessName: string;
  /** Session cookie of one API sign-in, reused by the specs that are not about logging in (Better Auth rate-limits sign-ins). */
  storageStatePath: string;
  /** A second owner with its own business and appointments, for the owner-switch regression. */
  ownerB: { email: string; password: string; businessId: string; businessName: string };
  /** Local (browser timezone) dates the data is anchored on. */
  dates: { today: string; yesterday: string; tomorrow: string; monday: string; sunday: string };
};

export function readState(): E2eState {
  const raw = process.env.E2E_STATE;
  if (!raw) throw new Error("E2E_STATE is not set: global setup did not run");
  return JSON.parse(raw) as E2eState;
}

/** Better Auth allows 3 sign-ins per 10 s, so a run started right after another waits for the window to pass. */
async function signInWithRetry(api: APIRequestContext, email: string, password: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const res = await api.post("/api/auth/sign-in/email", { data: { email, password } });
    if (res.ok()) return;
    if (res.status() !== 429 || attempt >= 5) {
      throw new Error(`POST /api/auth/sign-in/email failed with ${res.status()}: ${await res.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function post(api: APIRequestContext, path: string, data?: unknown) {
  const res = await api.post(path, data === undefined ? {} : { data });
  if (!res.ok()) throw new Error(`POST ${path} failed with ${res.status()}: ${await res.text()}`);
  return res.json();
}

type Credentials = { email: string; password: string; businessName: string };

/** Creates an owner and its business with the CLI (inside the api container). */
function createOwner(label: string, suffix: string): Credentials {
  const email = `e2e-${label}-${suffix}@example.test`;
  const password = randomBytes(12).toString("hex");
  const businessName = `E2E ${label === "a" ? "Agenda" : "Otro"} ${suffix}`;
  // The password travels in the environment of `docker compose` (`-e AUTH_PASSWORD` without a value), not in argv.
  compose(
    ["exec", "-T", "-e", "AUTH_PASSWORD", "api", "node", "apps/api/src/auth-cli.ts",
      "--email", email, "--name", `Dueña E2E ${label.toUpperCase()}`, "--business", businessName],
    { env: { AUTH_PASSWORD: password } },
  );
  return { email, password, businessName };
}

/** One API sign-in; the context keeps the session cookie. */
async function signedInApi(owner: Credentials): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
  try {
    await signInWithRetry(api, owner.email, owner.password);
    return api;
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

async function businessIdOf(api: APIRequestContext): Promise<string> {
  const me = (await (await api.get("/api/me")).json()) as { business: { id: string } };
  return me.business.id;
}

const createBooker =
  (api: APIRequestContext) => async (serviceId: string, date: string, time: string, phone: string, name?: string) =>
    (await post(api, "/api/appointments", {
      serviceId,
      startsAt: instant(date, time),
      customerPhone: phone,
      ...(name ? { customerName: name } : {}),
    })) as { id: string };

/**
 * Creates two uniquely named owners (A and B, each with its own business) with the CLI, signs each in once
 * through the API and seeds each business with its own services and appointments. Returns the state the specs read.
 * Sign-ins are rate limited, so A's session is also saved for the specs that are not about logging in.
 */
export async function seed(): Promise<E2eState> {
  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const created: Credentials[] = [];
  const scratchDir = mkdtempSync(join(tmpdir(), "gestion-e2e-"));
  const storageStatePath = join(scratchDir, "owner-session.json");
  let apiA: APIRequestContext | undefined;
  let apiB: APIRequestContext | undefined;

  try {
    const ownerA = createOwner("a", suffix);
    created.push(ownerA);
    const ownerB = createOwner("b", suffix);
    created.push(ownerB);

    const t = today();
    const dates = {
      today: t,
      yesterday: addDays(t, -1),
      tomorrow: addDays(t, 1),
      monday: mondayOf(t),
      sunday: addDays(mondayOf(t), 6),
    };

    // Owner A.
    apiA = await signedInApi(ownerA);
    await apiA.storageState({ path: storageStatePath });
    const businessId = await businessIdOf(apiA);
    const corte = (await post(apiA, "/api/services", { name: "Corte", durationMinutes: 30 })) as { id: string };
    const tinte = (await post(apiA, "/api/services", { name: "Tinte", durationMinutes: 60 })) as { id: string };
    const bookA = createBooker(apiA);
    // Today: a 30 min and a 60 min booking (the second customer has no name) and a cancelled one.
    await bookA(corte.id, dates.today, "09:00", "573001110001", "Ana Pérez");
    await bookA(tinte.id, dates.today, "11:00", "573001110002");
    const cancelled = await bookA(corte.id, dates.today, "15:00", "573001110003", "Clara Cita");
    await post(apiA, `/api/appointments/${cancelled.id}/cancel`);
    // Neighbouring days (navigation) and the two ends of the Monday-first week (week view columns).
    // The week ends are at 21:00, after every hour other specs book (they book on today and tomorrow, which can be
    // that Monday or Sunday: a 18:00 week-end booking made the 17:30-18:30 move and the 18:00 retry overlap on
    // Monday/Sunday/Saturday runs). Nothing is seeded after today + 6 (EMPTY_DAY_OFFSET in dates.ts).
    await bookA(corte.id, dates.tomorrow, "10:00", "573001110004", "Beto Mañana");
    await bookA(corte.id, dates.yesterday, "13:00", "573001110005", "Carla Ayer");
    await bookA(corte.id, dates.monday, "21:00", "573001110006", "Luis Lunes");
    await bookA(corte.id, dates.sunday, "21:00", "573001110007", "Dora Domingo");

    // Owner B: another business with a different set today (different names, hours and phones).
    apiB = await signedInApi(ownerB);
    const businessIdB = await businessIdOf(apiB);
    const manicure = (await post(apiB, "/api/services", { name: "Manicure", durationMinutes: 45 })) as { id: string };
    const bookB = createBooker(apiB);
    await bookB(manicure.id, dates.today, "10:30", "573002220001", "Bruno Beta");
    await bookB(manicure.id, dates.today, "16:00", "573002220002");

    return {
      ...ownerA,
      businessId,
      storageStatePath,
      dates,
      ownerB: { ...ownerB, businessId: businessIdB },
    };
  } catch (error) {
    for (const owner of created) await cleanup(owner).catch(() => undefined);
    rmSync(scratchDir, { recursive: true, force: true });
    throw error;
  } finally {
    await apiA?.dispose();
    await apiB?.dispose();
  }
}

/** Removes every row of the seeded business and its owner; scoped by business name and user email. */
export async function cleanup(who: { email: string; businessName: string }): Promise<void> {
  const sql = `
BEGIN;
CREATE TEMP TABLE e2e_target AS
  SELECT b.id AS business_id FROM businesses b WHERE b.name = :'business_name'
  UNION
  SELECT u.business_id FROM "user" u WHERE u.email = :'email' AND u.business_id IS NOT NULL;
DELETE FROM appointments WHERE business_id IN (SELECT business_id FROM e2e_target);
DELETE FROM customers WHERE business_id IN (SELECT business_id FROM e2e_target);
DELETE FROM services WHERE business_id IN (SELECT business_id FROM e2e_target);
DELETE FROM opening_hours WHERE business_id IN (SELECT business_id FROM e2e_target);
DELETE FROM "session" WHERE user_id IN (SELECT id FROM "user" WHERE email = :'email');
DELETE FROM account WHERE user_id IN (SELECT id FROM "user" WHERE email = :'email');
DELETE FROM "user" WHERE email = :'email';
DELETE FROM businesses WHERE id IN (SELECT business_id FROM e2e_target);
COMMIT;
`;
  compose(
    ["exec", "-T", "postgres", "psql", "-U", PG_USER, "-d", PG_DB, "-v", "ON_ERROR_STOP=1",
      "-v", `email=${who.email}`, "-v", `business_name=${who.businessName}`],
    { input: sql },
  );
}
