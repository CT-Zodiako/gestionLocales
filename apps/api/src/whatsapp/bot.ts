import { SlotTakenError } from "@gestion/db";
import type {
  cancelUpcomingAppointmentForPhone,
  createAppointment,
  findBookedAppointmentForPhoneAt,
  findService,
  findUpcomingAppointmentForPhone,
  listAppointments,
  listOpeningHours,
  listServices,
  listUpcomingAppointmentsForPhone,
  upsertCustomer,
} from "@gestion/db";
import { INCOMING_KIND, type IncomingContent } from "@gestion/shared";
import {
  addDays,
  computeDaySlots,
  dayBounds,
  formatLocalTime,
  isCalendarDate,
  localDateOf,
  weekdayOf,
  type BookedSpan,
  type DaySlot,
} from "./availability.ts";
import {
  buttonsMessage,
  listMessage,
  truncate,
  WHATSAPP_LIMITS,
  type ListRowInput,
  type OutgoingMessage,
} from "./messages.ts";

/** A data-layer function with its leading `db` argument already bound. */
type Bound<F> = F extends (db: never, ...args: infer Args) => infer Result ? (...args: Args) => Result : never;

/** What the bot reads and writes; `server.ts` binds each function to the database. */
export interface BotStore {
  listServices: Bound<typeof listServices>;
  findService: Bound<typeof findService>;
  listOpeningHours: Bound<typeof listOpeningHours>;
  listAppointments: Bound<typeof listAppointments>;
  upsertCustomer: Bound<typeof upsertCustomer>;
  createAppointment: Bound<typeof createAppointment>;
  findBookedAppointmentForPhoneAt: Bound<typeof findBookedAppointmentForPhoneAt>;
  listUpcomingAppointmentsForPhone: Bound<typeof listUpcomingAppointmentsForPhone>;
  findUpcomingAppointmentForPhone: Bound<typeof findUpcomingAppointmentForPhone>;
  cancelUpcomingAppointmentForPhone: Bound<typeof cancelUpcomingAppointmentForPhone>;
}

/** Set to true right after the bot changed the agenda; the webhook uses it to decide whether a failure can be retried. */
export interface EffectTracker {
  applied: boolean;
}

export interface BotContext {
  store: BotStore;
  businessId: string;
  businessName: string;
  /** IANA timezone of the business. */
  timezone: string;
  /** Sender number, digits only. The only identity the bot trusts. */
  phone: string;
  now: Date;
  effects: EffectTracker;
}

/** How many days ahead (today included) a customer can book. */
export const BOOKING_DAYS = 7;

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;

/** Reply ids: the whole conversation state, so each one is parsed strictly and validated against the database. */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const DATE = "\\d{4}-\\d{2}-\\d{2}";
const INSTANT = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";

const ID_PATTERNS = {
  menu: new RegExp("^menu:(home|book|mine|cancel)$"),
  servicesPage: new RegExp("^svcs:(\\d{1,4})$"),
  minePage: new RegExp("^mine:(\\d{1,4})$"),
  cancelPage: new RegExp("^cmore:(\\d{1,4})$"),
  service: new RegExp(`^svc:(${UUID})$`),
  day: new RegExp(`^day:(${UUID}):(${DATE})$`),
  more: new RegExp(`^more:(${UUID}):(${DATE}):(\\d{1,4})$`),
  slot: new RegExp(`^slot:(${UUID}):(${INSTANT})$`),
  confirm: new RegExp(`^ok:(${UUID}):(${INSTANT})$`),
  cancelAsk: new RegExp(`^cancel:(${UUID})$`),
  cancelConfirm: new RegExp(`^cancelok:(${UUID})$`),
} as const;

const ID = {
  home: "menu:home",
  book: "menu:book",
  mine: "menu:mine",
  cancel: "menu:cancel",
  servicesPage: (offset: number) => `svcs:${offset}`,
  minePage: (offset: number) => `mine:${offset}`,
  cancelPage: (offset: number) => `cmore:${offset}`,
  service: (serviceId: string) => `svc:${serviceId}`,
  day: (serviceId: string, date: string) => `day:${serviceId}:${date}`,
  more: (serviceId: string, date: string, offset: number) => `more:${serviceId}:${date}:${offset}`,
  slot: (serviceId: string, startsAt: Date) => `slot:${serviceId}:${startsAt.toISOString()}`,
  confirm: (serviceId: string, startsAt: Date) => `ok:${serviceId}:${startsAt.toISOString()}`,
  cancelAsk: (appointmentId: string) => `cancel:${appointmentId}`,
  cancelConfirm: (appointmentId: string) => `cancelok:${appointmentId}`,
} as const;

const COPY = {
  refused: "Esa opción ya no es válida.",
  chooseAction: "¿Qué quieres hacer?",
  noServices: "Por ahora no hay servicios disponibles para agendar. Intenta de nuevo más tarde.",
  noHours: "El negocio todavía no tiene horarios de atención configurados. Intenta de nuevo más tarde.",
  noDays: "No hay horarios disponibles en los próximos 7 días. Intenta de nuevo más tarde.",
  dayFull: "Ya no quedan horarios ese día. Elige otro:",
  slotTaken: "Ese horario se acaba de ocupar.",
  slotTakenDayFull: "Ese horario se acaba de ocupar y ya no quedan más ese día. Elige otro día:",
  noUpcoming: "No tienes citas próximas.",
  nothingToCancel: "No tienes citas para cancelar.",
  appointmentGone: "Esa cita ya no está disponible para cancelar.",
  cancelled: "Listo, tu cita fue cancelada ✅",
} as const;

/** `lun 10 mar` */
export function formatDay(date: string): string {
  const [, month = 1, day = 1] = date.split("-").map(Number);
  return `${WEEKDAYS[weekdayOf(date)]} ${day} ${MONTHS[month - 1]}`;
}

/** `lun 10 mar, 09:00`, in the business timezone. */
export function formatWhen(timezone: string, instant: Date): string {
  return `${formatDay(localDateOf(timezone, instant))}, ${formatLocalTime(timezone, instant)}`;
}

function mainMenu(ctx: BotContext, body?: string): OutgoingMessage {
  const greeting = `Hola 👋 Soy el asistente de ${truncate(ctx.businessName, 80)}. ${COPY.chooseAction}`;
  return buttonsMessage({
    to: ctx.phone,
    body: body === undefined ? greeting : `${body}\n\n${COPY.chooseAction}`,
    buttons: [
      { id: ID.book, title: "Agendar" },
      { id: ID.mine, title: "Mis citas" },
      { id: ID.cancel, title: "Cancelar" },
    ],
  });
}

function refuse(ctx: BotContext): OutgoingMessage {
  return mainMenu(ctx, COPY.refused);
}

function withNotice(notice: string | undefined, body: string): string {
  return notice === undefined ? body : `${notice}\n\n${body}`;
}

type ActiveService = Awaited<ReturnType<BotStore["findService"]>> & object;

async function findActiveService(ctx: BotContext, serviceId: string): Promise<ActiveService | null> {
  const service = await ctx.store.findService(ctx.businessId, serviceId.toLowerCase());
  return service?.active ? service : null;
}

/** Whether `date` is one of the days a customer may book: today up to `BOOKING_DAYS - 1` days ahead. */
function isBookableDate(ctx: BotContext, date: string): boolean {
  const today = localDateOf(ctx.timezone, ctx.now);
  return isCalendarDate(date) && date >= today && date <= addDays(today, BOOKING_DAYS - 1);
}

/** Candidate slots, with free/taken, of each given date for a service. */
async function loadDaySlots(
  ctx: BotContext,
  service: ActiveService,
  dates: string[],
): Promise<Array<{ date: string; slots: DaySlot[] }>> {
  const first = dates[0];
  const last = dates.at(-1);
  if (first === undefined || last === undefined) return [];

  const openingHours = await ctx.store.listOpeningHours(ctx.businessId);
  const appointments = await ctx.store.listAppointments({
    businessId: ctx.businessId,
    from: dayBounds(ctx.timezone, first).start,
    to: dayBounds(ctx.timezone, last).end,
  });
  const booked: BookedSpan[] = appointments
    .filter((appointment) => appointment.status === "booked")
    .map((appointment) => ({ startsAt: appointment.startsAt, endsAt: appointment.endsAt }));

  return dates.map((date) => ({
    date,
    slots: computeDaySlots({
      timezone: ctx.timezone,
      date,
      durationMinutes: service.durationMinutes,
      openingHours,
      booked,
      now: ctx.now,
    }),
  }));
}

/**
 * One page of a 10-row list: when more than 10 items remain, 9 items plus a "Más" row that carries the next offset.
 * An offset past the end (a stale button) starts over.
 */
function pageOf<T>(items: T[], offset: number): { start: number; shown: T[]; nextOffset: number | null } {
  const start = offset < items.length ? offset : 0;
  const remaining = items.length - start;
  const size = remaining > WHATSAPP_LIMITS.maxRows ? WHATSAPP_LIMITS.maxRows - 1 : remaining;
  return { start, shown: items.slice(start, start + size), nextOffset: remaining > size ? start + size : null };
}

async function showServices(ctx: BotContext, offset = 0): Promise<OutgoingMessage> {
  const services = (await ctx.store.listServices(ctx.businessId)).filter((service) => service.active);
  if (services.length === 0) return mainMenu(ctx, COPY.noServices);

  const page = pageOf(services, offset);
  const rows: ListRowInput[] = page.shown.map((service) => ({
    id: ID.service(service.id),
    title: service.name,
    description: `${service.durationMinutes} min`,
  }));
  if (page.nextOffset !== null) {
    rows.push({ id: ID.servicesPage(page.nextOffset), title: "Más servicios", description: `Quedan ${services.length - page.nextOffset} más` });
  }
  return listMessage({ to: ctx.phone, body: "¿Qué servicio quieres agendar?", buttonLabel: "Ver servicios", rows });
}

async function showDays(ctx: BotContext, service: ActiveService, notice?: string): Promise<OutgoingMessage> {
  const openingHours = await ctx.store.listOpeningHours(ctx.businessId);
  if (openingHours.length === 0) return mainMenu(ctx, COPY.noHours);

  const today = localDateOf(ctx.timezone, ctx.now);
  const dates = Array.from({ length: BOOKING_DAYS }, (_, index) => addDays(today, index)).filter((date) =>
    openingHours.some((range) => range.weekday === weekdayOf(date)),
  );
  const days = (await loadDaySlots(ctx, service, dates))
    .map(({ date, slots }) => ({ date, free: slots.filter((slot) => slot.free).length }))
    .filter((day) => day.free > 0);
  if (days.length === 0) return mainMenu(ctx, COPY.noDays);

  const rows: ListRowInput[] = days.map((day) => ({
    id: ID.day(service.id, day.date),
    title: formatDay(day.date),
    description: day.free === 1 ? "1 horario libre" : `${day.free} horarios libres`,
  }));
  return listMessage({
    to: ctx.phone,
    body: withNotice(notice, `¿Qué día quieres tu cita de ${truncate(service.name, 40)}?`),
    buttonLabel: "Ver días",
    rows,
  });
}

async function showSlots(
  ctx: BotContext,
  service: ActiveService,
  date: string,
  offset: number,
  /** True when the customer's own choice was just taken: the notice then says so. */
  justTaken = false,
): Promise<OutgoingMessage> {
  const [day] = await loadDaySlots(ctx, service, [date]);
  const free = (day?.slots ?? []).filter((slot) => slot.free);
  if (free.length === 0) return showDays(ctx, service, justTaken ? COPY.slotTakenDayFull : COPY.dayFull);

  const page = pageOf(free, offset);
  const description = `${truncate(service.name, 50)} · ${service.durationMinutes} min`;

  const rows: ListRowInput[] = page.shown.map((slot) => ({
    id: ID.slot(service.id, slot.startsAt),
    title: formatLocalTime(ctx.timezone, slot.startsAt),
    description,
  }));
  if (page.nextOffset !== null) {
    rows.push({
      id: ID.more(service.id, date, page.nextOffset),
      title: "Más horarios",
      description: `Quedan ${free.length - page.nextOffset} más`,
    });
  }
  return listMessage({
    to: ctx.phone,
    body: withNotice(justTaken ? COPY.slotTaken : undefined, `Elige la hora para el ${formatDay(date)}:`),
    buttonLabel: "Ver horarios",
    rows,
  });
}

type SlotCheck =
  | { status: "invalid" }
  | { status: "taken"; service: ActiveService; date: string; startsAt: Date }
  | { status: "free"; service: ActiveService; date: string; slot: DaySlot };

/**
 * Validates a slot id server-side: the service must be an active one of this business, the instant must be
 * canonical, inside the booking window, on the service's slot grid of an opening range and in the future.
 * A valid slot that someone else booked meanwhile is reported as taken.
 */
async function checkSlot(ctx: BotContext, serviceId: string, instant: string): Promise<SlotCheck> {
  const startsAt = new Date(instant);
  if (Number.isNaN(startsAt.getTime()) || startsAt.toISOString() !== instant) return { status: "invalid" };

  const service = await findActiveService(ctx, serviceId);
  if (!service) return { status: "invalid" };

  const date = localDateOf(ctx.timezone, startsAt);
  if (!isBookableDate(ctx, date)) return { status: "invalid" };

  const [day] = await loadDaySlots(ctx, service, [date]);
  const slot = day?.slots.find((candidate) => candidate.startsAt.getTime() === startsAt.getTime());
  if (!slot) return { status: "invalid" };
  return slot.free ? { status: "free", service, date, slot } : { status: "taken", service, date, startsAt };
}

/**
 * The slot is not available. If it is this customer's own booking of the same service at that time (a repeated
 * confirmation, a tap on a stale button, a concurrent duplicate), say so instead of "taken"; otherwise it was
 * taken by someone else: say that and offer the slots again.
 */
async function slotUnavailable(
  ctx: BotContext,
  service: ActiveService,
  date: string,
  startsAt: Date,
): Promise<OutgoingMessage> {
  const own = await ctx.store.findBookedAppointmentForPhoneAt({
    businessId: ctx.businessId,
    phone: ctx.phone,
    serviceId: service.id,
    startsAt,
  });
  if (own) {
    return mainMenu(
      ctx,
      `Ya tienes esa cita agendada ✅\n\n${truncate(service.name, 80)} (${service.durationMinutes} min)\n${formatWhen(ctx.timezone, startsAt)}`,
    );
  }
  return showSlots(ctx, service, date, 0, true);
}

async function confirmSlot(ctx: BotContext, serviceId: string, instant: string): Promise<OutgoingMessage> {
  const check = await checkSlot(ctx, serviceId, instant);
  if (check.status === "invalid") return refuse(ctx);
  if (check.status === "taken") return slotUnavailable(ctx, check.service, check.date, check.startsAt);

  const { service, slot, date } = check;
  return buttonsMessage({
    to: ctx.phone,
    body: `¿Confirmas tu cita?\n\n${truncate(service.name, 80)} (${service.durationMinutes} min)\n${formatWhen(ctx.timezone, slot.startsAt)}`,
    buttons: [
      { id: ID.confirm(service.id, slot.startsAt), title: "Confirmar" },
      { id: ID.day(service.id, date), title: "Otro horario" },
      { id: ID.home, title: "Menú" },
    ],
  });
}

async function book(ctx: BotContext, serviceId: string, instant: string): Promise<OutgoingMessage> {
  const check = await checkSlot(ctx, serviceId, instant);
  if (check.status === "invalid") return refuse(ctx);
  if (check.status === "taken") return slotUnavailable(ctx, check.service, check.date, check.startsAt);

  const { service, slot, date } = check;
  const customer = await ctx.store.upsertCustomer({ businessId: ctx.businessId, phone: ctx.phone });
  try {
    await ctx.store.createAppointment({
      businessId: ctx.businessId,
      customerId: customer.id,
      serviceId: service.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    });
  } catch (error) {
    // The database exclusion constraint is the authority: someone booked it after we listed the slots.
    if (error instanceof SlotTakenError) return slotUnavailable(ctx, service, date, slot.startsAt);
    throw error;
  }
  ctx.effects.applied = true;

  return mainMenu(
    ctx,
    `Tu cita quedó confirmada ✅\n\n${truncate(service.name, 80)} (${service.durationMinutes} min)\n${formatWhen(ctx.timezone, slot.startsAt)}`,
  );
}

const PAGE_SIZE = WHATSAPP_LIMITS.maxRows;

async function showMyAppointments(ctx: BotContext, offset = 0): Promise<OutgoingMessage> {
  const load = (from: number) =>
    // One more than a page, to know whether there are further ones.
    ctx.store.listUpcomingAppointmentsForPhone({
      businessId: ctx.businessId,
      phone: ctx.phone,
      from: ctx.now,
      limit: PAGE_SIZE + 1,
      offset: from,
    });
  let start = offset;
  let upcoming = await load(start);
  if (upcoming.length === 0 && start > 0) {
    // A stale offset (appointments were cancelled meanwhile): start over.
    start = 0;
    upcoming = await load(start);
  }
  if (upcoming.length === 0) return mainMenu(ctx, COPY.noUpcoming);

  const shown = upcoming.slice(0, PAGE_SIZE);
  const hasMore = upcoming.length > PAGE_SIZE;
  const lines = shown.map(
    (appointment) => `• ${formatWhen(ctx.timezone, appointment.startsAt)} — ${truncate(appointment.serviceName, 30)}`,
  );
  const range = hasMore || start > 0 ? ` (${start + 1}-${start + shown.length})` : "";
  const body = `Tus próximas citas${range}:\n${lines.join("\n")}`;
  if (!hasMore) return mainMenu(ctx, body);

  return buttonsMessage({
    to: ctx.phone,
    body,
    buttons: [
      { id: ID.minePage(start + PAGE_SIZE), title: "Ver más citas" },
      { id: ID.cancel, title: "Cancelar" },
      { id: ID.home, title: "Menú" },
    ],
  });
}

async function showCancelList(ctx: BotContext, offset = 0): Promise<OutgoingMessage> {
  const load = (from: number) =>
    ctx.store.listUpcomingAppointmentsForPhone({
      businessId: ctx.businessId,
      phone: ctx.phone,
      from: ctx.now,
      limit: PAGE_SIZE + 1,
      offset: from,
    });
  let start = offset;
  let upcoming = await load(start);
  if (upcoming.length === 0 && start > 0) {
    start = 0;
    upcoming = await load(start);
  }
  if (upcoming.length === 0) return mainMenu(ctx, COPY.nothingToCancel);

  // A list holds 10 rows: when more remain, 9 appointments plus the "Más citas" row.
  const hasMore = upcoming.length > PAGE_SIZE;
  const shown = upcoming.slice(0, hasMore ? PAGE_SIZE - 1 : PAGE_SIZE);
  const rows: ListRowInput[] = shown.map((appointment) => ({
    id: ID.cancelAsk(appointment.id),
    title: formatWhen(ctx.timezone, appointment.startsAt),
    description: appointment.serviceName,
  }));
  if (hasMore) rows.push({ id: ID.cancelPage(start + shown.length), title: "Más citas", description: "Ver las siguientes" });
  return listMessage({ to: ctx.phone, body: "¿Cuál cita quieres cancelar?", buttonLabel: "Ver mis citas", rows });
}

async function askToCancel(ctx: BotContext, appointmentId: string): Promise<OutgoingMessage> {
  const appointment = await ctx.store.findUpcomingAppointmentForPhone({
    businessId: ctx.businessId,
    phone: ctx.phone,
    appointmentId: appointmentId.toLowerCase(),
    from: ctx.now,
  });
  if (!appointment) return mainMenu(ctx, COPY.appointmentGone);

  return buttonsMessage({
    to: ctx.phone,
    body: `¿Quieres cancelar esta cita?\n\n${truncate(appointment.serviceName, 80)}\n${formatWhen(ctx.timezone, appointment.startsAt)}`,
    buttons: [
      { id: ID.cancelConfirm(appointment.id), title: "Sí, cancelar" },
      { id: ID.home, title: "No, volver" },
    ],
  });
}

async function cancel(ctx: BotContext, appointmentId: string): Promise<OutgoingMessage> {
  const cancelled = await ctx.store.cancelUpcomingAppointmentForPhone({
    businessId: ctx.businessId,
    phone: ctx.phone,
    appointmentId: appointmentId.toLowerCase(),
    from: ctx.now,
  });
  if (!cancelled) return mainMenu(ctx, COPY.appointmentGone);

  ctx.effects.applied = true;
  return mainMenu(ctx, COPY.cancelled);
}

async function showDaysFor(ctx: BotContext, serviceId: string): Promise<OutgoingMessage> {
  const service = await findActiveService(ctx, serviceId);
  return service ? showDays(ctx, service) : refuse(ctx);
}

async function showSlotsFor(ctx: BotContext, serviceId: string, date: string, offset: number): Promise<OutgoingMessage> {
  const service = await findActiveService(ctx, serviceId);
  if (!service || !isBookableDate(ctx, date)) return refuse(ctx);
  return showSlots(ctx, service, date, offset);
}

/** Dispatches a tapped reply id. Anything that is not exactly one of our ids is refused politely. */
async function handleReply(ctx: BotContext, id: string): Promise<OutgoingMessage> {
  let match: RegExpMatchArray | null;

  if ((match = id.match(ID_PATTERNS.menu))) {
    switch (match[1]) {
      case "book":
        return showServices(ctx);
      case "mine":
        return showMyAppointments(ctx);
      case "cancel":
        return showCancelList(ctx);
      default:
        return mainMenu(ctx);
    }
  }
  if ((match = id.match(ID_PATTERNS.servicesPage))) return showServices(ctx, Number(match[1]));
  if ((match = id.match(ID_PATTERNS.minePage))) return showMyAppointments(ctx, Number(match[1]));
  if ((match = id.match(ID_PATTERNS.cancelPage))) return showCancelList(ctx, Number(match[1]));
  if ((match = id.match(ID_PATTERNS.service))) return showDaysFor(ctx, match[1] ?? "");
  if ((match = id.match(ID_PATTERNS.day))) return showSlotsFor(ctx, match[1] ?? "", match[2] ?? "", 0);
  if ((match = id.match(ID_PATTERNS.more))) return showSlotsFor(ctx, match[1] ?? "", match[2] ?? "", Number(match[3]));
  if ((match = id.match(ID_PATTERNS.slot))) return confirmSlot(ctx, match[1] ?? "", match[2] ?? "");
  if ((match = id.match(ID_PATTERNS.confirm))) return book(ctx, match[1] ?? "", match[2] ?? "");
  if ((match = id.match(ID_PATTERNS.cancelAsk))) return askToCancel(ctx, match[1] ?? "");
  if ((match = id.match(ID_PATTERNS.cancelConfirm))) return cancel(ctx, match[1] ?? "");

  return refuse(ctx);
}

/**
 * The stateless menu bot: one incoming message in, one reply out. Free text of any kind shows the main menu;
 * a tapped reply id is parsed and validated against the database on every step, because the customer
 * controls what they send. The only identity is `ctx.phone`, the sender number.
 */
export async function handleIncoming(ctx: BotContext, content: IncomingContent): Promise<OutgoingMessage> {
  if (content.kind === INCOMING_KIND.TEXT) return mainMenu(ctx);
  return handleReply(ctx, content.id);
}
