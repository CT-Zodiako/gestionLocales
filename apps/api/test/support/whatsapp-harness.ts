import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  cancelUpcomingAppointmentForPhone,
  claimWhatsappMessage,
  completeWhatsappMessage,
  createAppointment,
  createService,
  ensureBusiness,
  findBookedAppointmentForPhoneAt,
  findService,
  findUpcomingAppointmentForPhone,
  findWhatsappChannel,
  getWhatsappMessageMarker,
  linkWhatsappChannel,
  listAppointmentDetails,
  listAppointments,
  listOpeningHours,
  listServices,
  listUpcomingAppointmentsForPhone,
  releaseWhatsappMessage,
  removeBusinessWithAgenda,
  setBusinessTimezone,
  setOpeningHours,
  upsertCustomer,
  type AppointmentDetail,
  type Database,
  type schema,
} from "@gestion/db";
import type { SweepOptions, SweepSummary } from "../../src/reminders/sweep.ts";
import { createServer, type Server } from "../../src/server.ts";
import type { OutgoingMessage } from "../../src/whatsapp/messages.ts";
import { createWhatsAppRoutes, type WhatsAppStore } from "../../src/whatsapp/webhook-routes.ts";
import { authSecret, authUrl, databaseUrl } from "./env.ts";
import {
  APP_SECRET,
  FakeWhatsAppClient,
  VERIFY_TOKEN,
  newWamid,
  replyPayload,
  sign,
  textPayload,
  type ReplyKind,
} from "./whatsapp.ts";

export const MINUTE = 60_000;

/** Template names and language the reminder tests configure; Meta only allows lowercase, digits and underscores. */
export const TEMPLATES = { confirmation: "cita_confirmacion", reminder: "cita_recordatorio", language: "es" } as const;
export const WEBHOOK = "/api/whatsapp/webhook";

/** Monday 2031-03-10 08:00 in Bogotá (UTC-5). */
export const MONDAY_MORNING = new Date("2031-03-10T13:00:00.000Z");

/**
 * Knobs of a controlled harness: the webhook runs against a store that wraps the real data layer so a test can
 * shorten the lease and make individual store operations fail.
 */
export interface Controls {
  /** Lease used by `claimMessage`; `0` makes every uncompleted marker immediately takeable. */
  leaseMs: number;
  fail: {
    /** Number of upcoming `findChannel` calls that throw (`Infinity` for all). */
    findChannel: number;
    /** Message ids whose claim throws. */
    claimWamids: Set<string>;
    /** Number of upcoming `releaseMessage` calls that throw. */
    release: number;
    /** Number of upcoming `completeMessage` calls that throw. */
    complete: number;
  };
  calls: { release: number; complete: number };
}

export interface HarnessOptions {
  /** Route the webhook through a fault-injecting store (see `Controls`). */
  controlled?: boolean;
  /** Enable reminders (the worker itself is never started; tests call `sweep`). */
  reminders?: boolean;
}

export interface Harness {
  server: Server;
  /** Present only for `createHarness({ controlled: true })`. */
  controls: Controls;
  /** Stored idempotency marker of a message id, or null. */
  marker: (wamid: string) => Promise<{ businessId: string; receivedAt: Date; completedAt: Date | null } | null>;
  client: FakeWhatsAppClient;
  /** Replaceable clock: every date the bot and the reminders reason about derives from it. */
  clock: { now: Date };
  /** One reminder sweep, by default over the businesses this harness created (never other tests' businesses). */
  sweep: (options?: SweepOptions) => Promise<SweepSummary>;
  logs: string[];
  /** Every business created through `newTenant`, removed by `close`. */
  businessIds: string[];
  newTenant: (options?: TenantOptions) => Promise<Tenant>;
  /** Posts a signed webhook body (or the given raw string). */
  post: (payload: unknown, options?: { signature?: string | null; raw?: string }) => Promise<Response>;
  close: () => Promise<void>;
}

export interface TenantOptions {
  /** Business name; defaults to a unique one. */
  name?: string;
  timezone?: string;
  /** Opening ranges to store; defaults to Monday to Friday 09:00-11:00. `null` stores none. */
  hours?: Array<{ weekday: number; opensAt: string; closesAt: string }> | null;
  /** Services to create (name, minutes); defaults to one "Corte" of 30 minutes. `[]` creates none. */
  services?: Array<{ name: string; durationMinutes: number; active?: boolean }>;
}

export interface Tenant {
  businessId: string;
  phoneNumberId: string;
  serviceIds: string[];
  harness: Harness;
  /** A customer sending messages to this business. */
  customer: (phone: string) => Customer;
  appointments: () => Promise<AppointmentDetail[]>;
  /** Books directly through the data layer, as "someone else" or the owner did. */
  bookDirect: (serviceId: string, phone: string, startsAt: Date, minutes: number) => Promise<schema.Appointment>;
}

export interface Customer {
  phone: string;
  /** Sends a text and returns the single reply it caused. */
  say: (text: string) => Promise<OutgoingMessage>;
  /** Taps a reply id and returns the single reply it caused. */
  tap: (id: string, kind?: ReplyKind) => Promise<OutgoingMessage>;
  /** Everything the business sent to this customer so far. */
  inbox: () => OutgoingMessage[];
}

function spend(fail: Controls["fail"], key: "findChannel" | "release" | "complete"): void {
  if (fail[key] > 0) {
    fail[key] -= 1;
    throw new Error(`simulated ${key} failure`);
  }
}

/** The production store wiring, with the faults and the lease of `controls` applied. */
function controlledStore(db: Database, controls: Controls): WhatsAppStore {
  return {
    findChannel: async (phoneNumberId) => {
      spend(controls.fail, "findChannel");
      return findWhatsappChannel(db, phoneNumberId);
    },
    claimMessage: async (input, options) => {
      if (controls.fail.claimWamids.has(input.wamid)) throw new Error("simulated claim failure");
      return claimWhatsappMessage(db, input, { leaseMs: controls.leaseMs, ...options });
    },
    releaseMessage: async (wamid) => {
      controls.calls.release += 1;
      spend(controls.fail, "release");
      return releaseWhatsappMessage(db, wamid);
    },
    completeMessage: async (wamid) => {
      controls.calls.complete += 1;
      spend(controls.fail, "complete");
      return completeWhatsappMessage(db, wamid);
    },
    listServices: (businessId) => listServices(db, businessId),
    findService: (businessId, serviceId) => findService(db, businessId, serviceId),
    listOpeningHours: (businessId) => listOpeningHours(db, businessId),
    listAppointments: (input) => listAppointments(db, input),
    upsertCustomer: (input) => upsertCustomer(db, input),
    createAppointment: (input) => createAppointment(db, input),
    findBookedAppointmentForPhoneAt: (input) => findBookedAppointmentForPhoneAt(db, input),
    listUpcomingAppointmentsForPhone: (input) => listUpcomingAppointmentsForPhone(db, input),
    findUpcomingAppointmentForPhone: (input) => findUpcomingAppointmentForPhone(db, input),
    cancelUpcomingAppointmentForPhone: (input) => cancelUpcomingAppointmentForPhone(db, input),
  };
}

export async function createHarness(harnessOptions: HarnessOptions = {}): Promise<Harness> {
  const client = new FakeWhatsAppClient();
  const clock = { now: MONDAY_MORNING };
  const logs: string[] = [];
  const capture = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    logs.push(`${level} ${message} ${fields ? JSON.stringify(fields) : ""}`);
  };
  const logger = { info: capture("info"), warn: capture("warn"), error: capture("error") };
  const server = createServer({
    databaseUrl,
    authSecret,
    authUrl,
    whatsapp: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, client, now: () => clock.now, logger },
    ...(harnessOptions.reminders ? { reminders: { templates: TEMPLATES, now: () => clock.now, logger } } : {}),
  });
  const businessIds: string[] = [];
  const controls: Controls = {
    leaseMs: 120_000,
    fail: { findChannel: 0, claimWamids: new Set(), release: 0, complete: 0 },
    calls: { release: 0, complete: 0 },
  };
  const controlled = harnessOptions.controlled
    ? new Hono().route(
        "/api/whatsapp",
        createWhatsAppRoutes({
          appSecret: APP_SECRET,
          verifyToken: VERIFY_TOKEN,
          client,
          now: () => clock.now,
          logger: { info: capture("info"), warn: capture("warn"), error: capture("error") },
          store: controlledStore(server.db, controls),
        }),
      )
    : undefined;

  const harness: Harness = {
    server,
    controls,
    marker: (wamid) => getWhatsappMessageMarker(server.db, wamid),
    client,
    clock,
    sweep: (options) => {
      if (!server.reminders) throw new Error("this harness was created without reminders");
      return server.reminders.sweep({ businessIds, ...options });
    },
    logs,
    businessIds,
    newTenant: (options) => createTenant(harness, options),
    post: async (payload, options = {}) => {
      const raw = options.raw ?? JSON.stringify(payload);
      const headers: Record<string, string> = { "content-type": "application/json" };
      const signature = options.signature === undefined ? sign(raw) : options.signature;
      if (signature !== null) headers["x-hub-signature-256"] = signature;
      return await (controlled ?? server.app).request(WEBHOOK, { method: "POST", headers, body: raw });
    },
    close: async () => {
      for (const id of businessIds) await removeBusinessWithAgenda(server.db, id);
      await server.close();
    },
  };
  return harness;
}

const WEEKDAY_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensAt: "09:00", closesAt: "11:00" }));

async function createTenant(harness: Harness, options: TenantOptions = {}): Promise<Tenant> {
  const { server } = harness;
  const business = await ensureBusiness(server.db, options.name ?? `WhatsApp test ${randomUUID()}`);
  harness.businessIds.push(business.id); // registered first, so a failing setup still gets cleaned up
  if (options.timezone) await setBusinessTimezone(server.db, business.id, options.timezone);

  const phoneNumberId = `1${Math.floor(Math.random() * 1e14)
    .toString()
    .padStart(14, "0")}`;
  const linked = await linkWhatsappChannel(server.db, business.id, phoneNumberId);
  if (linked !== "linked") throw new Error(`could not link a test channel: ${linked}`);

  const hours = options.hours === undefined ? WEEKDAY_HOURS : options.hours;
  if (hours) await setOpeningHours(server.db, business.id, hours);

  const serviceIds: string[] = [];
  for (const service of options.services ?? [{ name: "Corte", durationMinutes: 30 }]) {
    const created = await createService(server.db, { businessId: business.id, ...service });
    serviceIds.push(created.id);
  }

  const customer = (phone: string): Customer => {
    const options = { phoneNumberId, from: phone };
    const exchange = async (payload: Record<string, unknown>): Promise<OutgoingMessage> => {
      const before = harness.client.messagesTo(phone).length;
      const res = await harness.post(payload);
      if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
      const inbox = harness.client.messagesTo(phone);
      const fresh = inbox.slice(before);
      const last = fresh.at(-1);
      if (fresh.length !== 1 || !last) throw new Error(`expected exactly one reply, got ${fresh.length}`);
      return last;
    };
    return {
      phone,
      say: (text) => exchange(textPayload({ ...options, wamid: newWamid() }, text)),
      tap: (id, kind) => exchange(replyPayload({ ...options, wamid: newWamid() }, id, kind)),
      inbox: () => harness.client.messagesTo(phone),
    };
  };

  return {
    businessId: business.id,
    phoneNumberId,
    serviceIds,
    harness,
    customer,
    appointments: () =>
      listAppointmentDetails(server.db, {
        businessId: business.id,
        from: new Date("2000-01-01T00:00:00Z"),
        to: new Date("2100-01-01T00:00:00Z"),
      }),
    bookDirect: async (serviceId, phone, startsAt, minutes) => {
      const person = await upsertCustomer(server.db, { businessId: business.id, phone });
      return createAppointment(server.db, {
        businessId: business.id,
        customerId: person.id,
        serviceId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + minutes * MINUTE),
      });
    },
  };
}

// --- reading what the bot sent -------------------------------------------------

export function bodyOf(message: OutgoingMessage): string {
  return message.type === "text" ? message.text.body : message.interactive.body.text;
}

/** Reply ids the customer can tap (buttons or list rows), in order. */
export function replyIdsOf(message: OutgoingMessage): string[] {
  if (message.type === "text") return [];
  if (message.interactive.type === "button") return message.interactive.action.buttons.map((button) => button.reply.id);
  return message.interactive.action.sections.flatMap((section) => section.rows.map((row) => row.id));
}

export function titlesOf(message: OutgoingMessage): string[] {
  if (message.type === "text") return [];
  if (message.interactive.type === "button") return message.interactive.action.buttons.map((button) => button.reply.title);
  return message.interactive.action.sections.flatMap((section) => section.rows.map((row) => row.title));
}

/** The id of the first reply whose id starts with `prefix`; throws when there is none. */
export function pick(message: OutgoingMessage, prefix: string): string {
  const id = replyIdsOf(message).find((candidate) => candidate.startsWith(prefix));
  if (!id) throw new Error(`no reply id starting with ${prefix} in ${JSON.stringify(message)}`);
  return id;
}

export const MENU_IDS = ["menu:book", "menu:mine", "menu:cancel"];
