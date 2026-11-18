-- Hand-written: needed so the exclusion constraint below can combine uuid equality with range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_ends_after_starts" CHECK ("appointments"."ends_at" > "appointments"."starts_at"),
	CONSTRAINT "appointments_status_valid" CHECK ("appointments"."status" in ('booked', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_business_phone_unique" UNIQUE("business_id","phone"),
	CONSTRAINT "customers_id_business_id_unique" UNIQUE("id","business_id")
);
--> statement-breakpoint
CREATE TABLE "opening_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	CONSTRAINT "opening_hours_weekday_range" CHECK ("opening_hours"."weekday" between 0 and 6),
	CONSTRAINT "opening_hours_closes_after_opens" CHECK ("opening_hours"."closes_at" > "opening_hours"."opens_at")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_id_business_id_unique" UNIQUE("id","business_id"),
	CONSTRAINT "services_duration_minutes_positive" CHECK ("services"."duration_minutes" > 0)
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_business_fk" FOREIGN KEY ("customer_id","business_id") REFERENCES "public"."customers"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_business_fk" FOREIGN KEY ("service_id","business_id") REFERENCES "public"."services"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_hours" ADD CONSTRAINT "opening_hours_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_business_starts_at_idx" ON "appointments" USING btree ("business_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_customer_id_idx" ON "appointments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "appointments_service_id_idx" ON "appointments" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "opening_hours_business_weekday_idx" ON "opening_hours" USING btree ("business_id","weekday");--> statement-breakpoint
CREATE INDEX "services_business_id_idx" ON "services" USING btree ("business_id");--> statement-breakpoint
-- Hand-written (drizzle-kit cannot express exclusion constraints): one agenda per business, no overlapping
-- booked appointments; back-to-back is allowed (tstzrange is [) ) and cancelled appointments free their slot.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap" EXCLUDE USING gist ("business_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&) WHERE ("status" <> 'cancelled');
