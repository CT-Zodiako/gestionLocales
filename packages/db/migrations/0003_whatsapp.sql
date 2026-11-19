CREATE TABLE "whatsapp_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"phone_number_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_channels_phone_number_id_unique" UNIQUE("phone_number_id")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_processed_messages" (
	"wamid" text PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_channels" ADD CONSTRAINT "whatsapp_channels_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_processed_messages" ADD CONSTRAINT "whatsapp_processed_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_channels_business_id_idx" ON "whatsapp_channels" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "whatsapp_processed_messages_business_id_idx" ON "whatsapp_processed_messages" USING btree ("business_id");