CREATE TABLE "appointment_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"whatsapp_message_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_reminders_appointment_kind_unique" UNIQUE("appointment_id","kind"),
	CONSTRAINT "appointment_reminders_kind_valid" CHECK ("appointment_reminders"."kind" in ('confirmation', 'reminder_24h')),
	CONSTRAINT "appointment_reminders_status_valid" CHECK ("appointment_reminders"."status" in ('pending', 'sending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "appointment_reminders_attempts_non_negative" CHECK ("appointment_reminders"."attempts" >= 0)
);
--> statement-breakpoint
-- Target of the composite foreign key below; must exist before it (drizzle-kit emitted it last).
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_id_business_id_unique" UNIQUE("id","business_id"); --> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_appointment_business_fk" FOREIGN KEY ("appointment_id","business_id") REFERENCES "public"."appointments"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_reminders_status_due_at_idx" ON "appointment_reminders" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "appointment_reminders_business_id_idx" ON "appointment_reminders" USING btree ("business_id");
