import {
  type CreateAppointmentBody,
  type CreateServiceBody,
  createAppointmentBodySchema,
  createServiceBodySchema,
  instantSchema,
  MAX_SERVICE_PRICE,
  type MoveAppointmentBody,
  moveAppointmentBodySchema,
  priceSchema,
  PHONE_MAX_DIGITS,
  PHONE_MIN_DIGITS,
  phoneSchema,
  type UpdateServiceBody,
  updateServiceBodySchema,
} from "@gestion/shared";
import { z } from "zod";
import { ApiError } from "./api.ts";
import { formatPrice } from "./services.ts";

/**
 * ISO instant of a local date (`YYYY-MM-DD`) and time (`HH:MM`) in the browser timezone, or null when that wall
 * time does not exist (not a calendar date, skipped by a DST change) or falls outside what the API accepts.
 */
export function localInstant(date: string, time: string): string | null {
  const parts = [...date.split("-"), ...time.split(":")].map(Number);
  if (parts.length !== 5 || parts.some(Number.isNaN)) return null;
  const [year, month, day, hours, minutes] = parts as [number, number, number, number, number];

  const local = new Date(year, month - 1, day, hours, minutes);
  const sameWallTime =
    local.getFullYear() === year &&
    local.getMonth() === month - 1 &&
    local.getDate() === day &&
    local.getHours() === hours &&
    local.getMinutes() === minutes;
  if (!sameWallTime) return null;

  const instant = local.toISOString();
  return instantSchema.safeParse(instant).success ? instant : null;
}

const scheduleShape = {
  date: z.string().min(1, "Elige una fecha"),
  time: z.string().min(1, "Elige una hora"),
};

/** Date and time together must make an instant; empty fields already have their own message. */
function checkSchedule(value: { date: string; time: string }, ctx: z.RefinementCtx): void {
  if (value.date && value.time && localInstant(value.date, value.time) === null) {
    ctx.addIssue({ code: "custom", path: ["time"], message: "Esa fecha u hora no es válida" });
  }
}

const NAME_TOO_LONG = "El nombre admite hasta 120 caracteres";

/** Booking form; the phone rules are the shared `phoneSchema`'s (spaces, dashes, a leading + are fine; 8-15 digits). */
export const bookingFormSchema = z
  .object({
    customerPhone: z
      .string()
      .trim()
      .min(1, "Ingresa el teléfono del cliente")
      .refine(
        (value) => phoneSchema.safeParse(value).success,
        `El teléfono debe tener entre ${PHONE_MIN_DIGITS} y ${PHONE_MAX_DIGITS} dígitos`,
      ),
    customerName: z.string().trim().max(120, NAME_TOO_LONG),
    serviceId: z.string().min(1, "Elige un servicio"),
    ...scheduleShape,
  })
  .superRefine(checkSchedule);

export type BookingFormValues = z.infer<typeof bookingFormSchema>;

export const moveFormSchema = z.object(scheduleShape).superRefine(checkSchedule);

export type MoveFormValues = z.infer<typeof moveFormSchema>;

export const PRICE_INVALID = "El precio debe ser un número entero de pesos, sin decimales";
export const PRICE_TOO_HIGH = `El precio no puede superar ${formatPrice(MAX_SERVICE_PRICE)}`;
const DURATION_INVALID = "La duración debe ser un número entero de minutos entre 1 y 1440";

export const serviceFormSchema = z.object({
  name: z.string().trim().min(1, "Ingresa el nombre del servicio").max(120, NAME_TOO_LONG),
  durationMinutes: z
    .string()
    .trim()
    .refine(
      (value) => /^\d+$/.test(value) && createServiceBodySchema.shape.durationMinutes.safeParse(Number(value)).success,
      DURATION_INVALID,
    ),
  // Optional: empty means no price. Whole pesos only (digits, no sign, point or comma).
  price: z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      if (value === "") return;
      if (!/^\d+$/.test(value)) {
        ctx.addIssue({ code: "custom", message: PRICE_INVALID });
      } else if (!priceSchema.safeParse(Number(value)).success) {
        ctx.addIssue({ code: "custom", message: PRICE_TOO_HIGH });
      }
    }),
});

export type ServiceFormValues = z.infer<typeof serviceFormSchema>;

/** The edit form adds the "Activo" switch. */
export const serviceEditFormSchema = serviceFormSchema.extend({ active: z.boolean() });

export type ServiceEditFormValues = z.infer<typeof serviceEditFormSchema>;

// The form schemas only add messages and the date/time pairing; what is sent is parsed by the API's own schemas.
// (Values reaching these builders have passed the form schemas, so the parses cannot fail.)

export function toCreateBody(values: BookingFormValues): CreateAppointmentBody {
  return createAppointmentBodySchema.parse({
    customerPhone: values.customerPhone,
    customerName: values.customerName === "" ? undefined : values.customerName,
    serviceId: values.serviceId,
    startsAt: localInstant(values.date, values.time),
  });
}

export function toMoveBody(values: MoveFormValues): MoveAppointmentBody {
  return moveAppointmentBodySchema.parse({ startsAt: localInstant(values.date, values.time) });
}

export function toServiceBody(values: ServiceFormValues): CreateServiceBody {
  return createServiceBodySchema.parse({
    name: values.name,
    durationMinutes: Number(values.durationMinutes),
    ...(values.price === "" ? {} : { price: Number(values.price) }),
  });
}

/** Full PATCH body of the edit dialog: an empty price field clears the price (`null`). */
export function toUpdateServiceBody(values: ServiceEditFormValues): UpdateServiceBody {
  return updateServiceBodySchema.parse({
    name: values.name,
    durationMinutes: Number(values.durationMinutes),
    price: values.price === "" ? null : Number(values.price),
    active: values.active,
  });
}

export const SLOT_TAKEN_MESSAGE = "Ese horario ya está ocupado";
const GENERIC_MESSAGE = "Ocurrió un error. Inténtalo de nuevo.";

export type WriteKind = "create" | "move" | "cancel" | "service" | "service-edit";

/**
 * Spanish message for a failed write. 409 is an overlap, 404 means what was acted on no longer exists
 * (the service of a booking, or the appointment), 400 is a rejection of the input the form schemas should have
 * caught (the API answers `invalid_request` without field details), anything else (500, network) is generic.
 */
export function writeErrorMessage(error: unknown, kind: WriteKind): string {
  if (error instanceof ApiError) {
    if (kind === "service-edit" && error.status === 404) return "Ese servicio ya no existe. Actualizamos la lista.";
    if (error.status === 409) return SLOT_TAKEN_MESSAGE;
    if (error.status === 404) {
      return kind === "create"
        ? "El servicio elegido ya no existe. Actualizamos la lista."
        : "Esa cita ya no existe. Actualizamos la agenda.";
    }
    if (error.status === 400) return "El servidor no aceptó los datos. Revisa el formulario e inténtalo de nuevo.";
  }
  return GENERIC_MESSAGE;
}
