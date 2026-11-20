CREATE TABLE "whatsapp_pending_names" (
	"business_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_pending_names_pk" PRIMARY KEY("business_id","phone"),
	CONSTRAINT "whatsapp_pending_names_attempts_non_negative" CHECK ("whatsapp_pending_names"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "price" integer;--> statement-breakpoint
ALTER TABLE "whatsapp_pending_names" ADD CONSTRAINT "whatsapp_pending_names_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_price_valid" CHECK ("services"."price" is null or ("services"."price" >= 0 and "services"."price" <= 100000000));