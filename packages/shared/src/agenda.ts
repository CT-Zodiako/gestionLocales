import { z } from "zod";

/** Longest `[from, to)` window GET /api/appointments accepts. */
export const MAX_RANGE_DAYS = 62;

const DAY_MS = 24 * 60 * 60 * 1000;

export const PHONE_MIN_DIGITS = 8;
export const PHONE_MAX_DIGITS = 15;

/** Strips spaces, dashes, parentheses and a leading `+`, leaving the digits-only E.164-like form. */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-()]/g, "").replace(/^\+/, "");
}

/** Phone as typed by the user; the parsed value is the normalized digits (8 to 15 of them). */
export const phoneSchema = z
  .string()
  .transform(normalizePhone)
  .pipe(z.string().regex(new RegExp(`^\\d{${PHONE_MIN_DIGITS},${PHONE_MAX_DIGITS}}$`)));

/** First instant of the earliest and of the first excluded year an instant may fall in (2000 to 2100). */
const MIN_INSTANT_MS = Date.UTC(2000, 0, 1);
const MAX_INSTANT_MS = Date.UTC(2101, 0, 1);

/** ISO 8601 instant with a `Z` or numeric offset (local date-times are rejected), within the years 2000-2100. */
export const instantSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) >= MIN_INSTANT_MS && Date.parse(value) < MAX_INSTANT_MS, {
    message: "The instant must fall between the years 2000 and 2100",
  });

export const APPOINTMENT_STATUS = {
  BOOKED: "booked",
  CANCELLED: "cancelled",
} as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUS)[keyof typeof APPOINTMENT_STATUS];

export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUS);

/** Query of GET /api/appointments: the half-open window `[from, to)`. */
export const listAppointmentsQuerySchema = z
  .object({ from: instantSchema, to: instantSchema })
  .refine(({ from, to }) => Date.parse(to) > Date.parse(from), {
    message: "`to` must be after `from`",
    path: ["to"],
  })
  .refine(({ from, to }) => Date.parse(to) - Date.parse(from) <= MAX_RANGE_DAYS * DAY_MS, {
    message: `The range must not exceed ${MAX_RANGE_DAYS} days`,
    path: ["to"],
  });

export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;

/** Body of POST /api/appointments. The business always comes from the session. */
export const createAppointmentBodySchema = z.object({
  customerPhone: phoneSchema,
  customerName: z.string().trim().min(1).max(120).optional(),
  serviceId: z.uuid(),
  startsAt: instantSchema,
});

export type CreateAppointmentBody = z.infer<typeof createAppointmentBodySchema>;

/** Body of PATCH /api/appointments/:id: the new start; the duration is kept. */
export const moveAppointmentBodySchema = z.object({
  startsAt: instantSchema,
});

export type MoveAppointmentBody = z.infer<typeof moveAppointmentBodySchema>;

/** Path parameter `:id` of the appointment routes. */
export const appointmentIdParamSchema = z.object({ id: z.uuid() });

/** Appointment as returned by POST, PATCH and cancel. */
export const appointmentSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  serviceId: z.uuid(),
  startsAt: instantSchema,
  endsAt: instantSchema,
  status: appointmentStatusSchema,
});

export type AppointmentResponse = z.infer<typeof appointmentSchema>;

/** Appointment with its customer and service, as listed by GET /api/appointments. */
export const appointmentDetailSchema = appointmentSchema.extend({
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  serviceName: z.string(),
});

export type AppointmentDetailResponse = z.infer<typeof appointmentDetailSchema>;

export const listAppointmentsResponseSchema = z.object({
  appointments: z.array(appointmentDetailSchema),
});

export type ListAppointmentsResponse = z.infer<typeof listAppointmentsResponseSchema>;

/** Body of POST /api/services. */
export const createServiceBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  durationMinutes: z.number().int().min(1).max(24 * 60),
});

export type CreateServiceBody = z.infer<typeof createServiceBodySchema>;

export const serviceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  durationMinutes: z.number().int(),
  active: z.boolean(),
});

export type ServiceResponse = z.infer<typeof serviceSchema>;

export const listServicesResponseSchema = z.object({
  services: z.array(serviceSchema),
});

export type ListServicesResponse = z.infer<typeof listServicesResponseSchema>;

/** Time of day, `HH:MM` (24 h). */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** One opening range of a weekday (0 = Sunday ... 6 = Saturday); several per weekday are allowed. */
export const openingRangeSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    opensAt: timeOfDaySchema,
    closesAt: timeOfDaySchema,
  })
  .refine(({ opensAt, closesAt }) => closesAt > opensAt, {
    message: "`closesAt` must be after `opensAt`",
    path: ["closesAt"],
  });

export type OpeningRange = z.infer<typeof openingRangeSchema>;

/** Body of PUT /api/opening-hours and response of GET/PUT: the whole week. */
export const openingHoursSchema = z.object({
  hours: z.array(openingRangeSchema),
});

export type OpeningHoursResponse = z.infer<typeof openingHoursSchema>;
