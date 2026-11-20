import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * A business using the product. Every other table will reference it
 * through business_id so the app can become multi-business later.
 */
export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/Bogota"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Better Auth tables. The column set mirrors what Better Auth 1.7 expects from
 * its Drizzle adapter (see `getSchema(auth.options)`); the only extra column is
 * `business_id`, which links the single business owner to its business.
 */
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  businessId: uuid("business_id").references(() => businesses.id),
});

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/** End customers, identified by their WhatsApp phone number (E.164) within a business. */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    phone: text("phone").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("customers_business_phone_unique").on(table.businessId, table.phone),
    // Target of the composite foreign key from appointments (a row can only be used within its own business).
    unique("customers_id_business_id_unique").on(table.id, table.businessId),
  ],
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    name: text("name").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    active: boolean("active").notNull().default(true),
    /** Whole Colombian pesos (no cents); null means no price is shown. */
    price: integer("price"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("services_business_id_idx").on(table.businessId),
    // Target of the composite foreign key from appointments.
    unique("services_id_business_id_unique").on(table.id, table.businessId),
    check("services_duration_minutes_positive", sql`${table.durationMinutes} > 0`),
    check("services_price_valid", sql`${table.price} is null or (${table.price} >= 0 and ${table.price} <= 100000000)`),
  ],
);

/** Weekly opening ranges; weekday 0-6, several ranges per weekday allowed. */
export const openingHours = pgTable(
  "opening_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    weekday: smallint("weekday").notNull(),
    opensAt: time("opens_at").notNull(),
    closesAt: time("closes_at").notNull(),
  },
  (table) => [
    index("opening_hours_business_weekday_idx").on(table.businessId, table.weekday),
    check("opening_hours_weekday_range", sql`${table.weekday} between 0 and 6`),
    check("opening_hours_closes_after_opens", sql`${table.closesAt} > ${table.opensAt}`),
  ],
);

export const APPOINTMENT_STATUS = {
  BOOKED: "booked",
  CANCELLED: "cancelled",
} as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUS)[keyof typeof APPOINTMENT_STATUS];

/**
 * One agenda per business. The no-overlap rule is a hand-written exclusion
 * constraint in migration 0002 (`appointments_no_overlap`); drizzle-kit cannot express it.
 */
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    customerId: uuid("customer_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").$type<AppointmentStatus>().notNull().default(APPOINTMENT_STATUS.BOOKED),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Composite foreign keys: the customer and the service must belong to the appointment's business.
    foreignKey({
      name: "appointments_customer_business_fk",
      columns: [table.customerId, table.businessId],
      foreignColumns: [customers.id, customers.businessId],
    }),
    foreignKey({
      name: "appointments_service_business_fk",
      columns: [table.serviceId, table.businessId],
      foreignColumns: [services.id, services.businessId],
    }),
    index("appointments_business_starts_at_idx").on(table.businessId, table.startsAt),
    index("appointments_customer_id_idx").on(table.customerId),
    index("appointments_service_id_idx").on(table.serviceId),
    // Target of the composite foreign key from appointment_reminders (a reminder can only point at an appointment of its own business).
    unique("appointments_id_business_id_unique").on(table.id, table.businessId),
    check("appointments_ends_after_starts", sql`${table.endsAt} > ${table.startsAt}`),
    check("appointments_status_valid", sql`${table.status} in ('booked', 'cancelled')`),
  ],
);

/**
 * Maps a WhatsApp Business phone number (Meta's `phone_number_id`) to the business that owns it, so an
 * incoming webhook message is routed to the right business. One phone number belongs to one business.
 */
export const whatsappChannels = pgTable(
  "whatsapp_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    phoneNumberId: text("phone_number_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("whatsapp_channels_business_id_idx").on(table.businessId)],
);

/**
 * Idempotency markers: one row per WhatsApp message id (`wamid`) the webhook has started handling.
 * The primary key makes a retried or concurrently duplicated delivery a no-op. `completed_at` is set once
 * handling ended without needing a retry; a marker that never completes (a crash) is a lease: after
 * `received_at` + lease a retry may take it over (`claimWhatsappMessage`).
 */
export const whatsappProcessedMessages = pgTable(
  "whatsapp_processed_messages",
  {
    wamid: text("wamid").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("whatsapp_processed_messages_business_id_idx").on(table.businessId)],
);

/**
 * The bot asked this sender for their name and waits for the next free text. One row per business and phone
 * (upsert); a row past `expires_at` is ignored. The customer row may not exist yet (it is created when the name is
 * saved), so the key is the pair business + phone rather than a foreign key to `customers`.
 */
export const whatsappPendingNames = pgTable(
  "whatsapp_pending_names",
  {
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    phone: text("phone").notNull(),
    /** Invalid names answered so far (the bot gives up on the second). */
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "whatsapp_pending_names_pk", columns: [table.businessId, table.phone] }),
    check("whatsapp_pending_names_attempts_non_negative", sql`${table.attempts} >= 0`),
  ],
);

export const REMINDER_KIND = {
  /** Sent right after the appointment is created. */
  CONFIRMATION: "confirmation",
  /** Sent 24 hours before the appointment starts. */
  REMINDER_24H: "reminder_24h",
} as const;

export type ReminderKind = (typeof REMINDER_KIND)[keyof typeof REMINDER_KIND];

export const REMINDER_STATUS = {
  PENDING: "pending",
  /** Claimed by a sweep: the lease (`claimed_at`) protects it from other sweeps until it expires. */
  SENDING: "sending",
  SENT: "sent",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;

export type ReminderStatus = (typeof REMINDER_STATUS)[keyof typeof REMINDER_STATUS];

/**
 * Source of truth for WhatsApp reminders: one row per appointment and kind, created in the same transaction as
 * the appointment. The sweep claims due `pending` rows (`sending` + `claimed_at` lease) before it calls WhatsApp.
 * `last_error` only ever holds a short, credential-free and phone-free description.
 */
export const appointmentReminders = pgTable(
  "appointment_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    appointmentId: uuid("appointment_id").notNull(),
    kind: text("kind").$type<ReminderKind>().notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: text("status").$type<ReminderStatus>().notNull().default(REMINDER_STATUS.PENDING),
    /** Send attempts started (each claim counts one, including a retaken stale claim). */
    attempts: integer("attempts").notNull().default(0),
    /** When the current claim started; the lease runs from here. Null unless `sending`. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    whatsappMessageId: text("whatsapp_message_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The appointment must belong to the same business as the reminder.
    foreignKey({
      name: "appointment_reminders_appointment_business_fk",
      columns: [table.appointmentId, table.businessId],
      foreignColumns: [appointments.id, appointments.businessId],
    }),
    unique("appointment_reminders_appointment_kind_unique").on(table.appointmentId, table.kind),
    index("appointment_reminders_status_due_at_idx").on(table.status, table.dueAt),
    index("appointment_reminders_business_id_idx").on(table.businessId),
    check("appointment_reminders_kind_valid", sql`${table.kind} in ('confirmation', 'reminder_24h')`),
    check(
      "appointment_reminders_status_valid",
      sql`${table.status} in ('pending', 'sending', 'sent', 'failed', 'skipped')`,
    ),
    check("appointment_reminders_attempts_non_negative", sql`${table.attempts} >= 0`),
  ],
);

export type User = typeof users.$inferSelect;
export type Business = typeof businesses.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Service = typeof services.$inferSelect;
export type OpeningHour = typeof openingHours.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type WhatsappChannel = typeof whatsappChannels.$inferSelect;
export type WhatsappPendingName = typeof whatsappPendingNames.$inferSelect;
export type AppointmentReminder = typeof appointmentReminders.$inferSelect;
