import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
