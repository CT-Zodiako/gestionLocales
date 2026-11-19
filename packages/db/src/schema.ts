import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("services_business_id_idx").on(table.businessId),
    // Target of the composite foreign key from appointments.
    unique("services_id_business_id_unique").on(table.id, table.businessId),
    check("services_duration_minutes_positive", sql`${table.durationMinutes} > 0`),
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
 * The primary key plus `ON CONFLICT DO NOTHING` makes a retried or concurrently duplicated delivery a no-op.
 */
export const whatsappProcessedMessages = pgTable(
  "whatsapp_processed_messages",
  {
    wamid: text("wamid").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("whatsapp_processed_messages_business_id_idx").on(table.businessId)],
);

export type User = typeof users.$inferSelect;
export type Business = typeof businesses.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Service = typeof services.$inferSelect;
export type OpeningHour = typeof openingHours.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type WhatsappChannel = typeof whatsappChannels.$inferSelect;
