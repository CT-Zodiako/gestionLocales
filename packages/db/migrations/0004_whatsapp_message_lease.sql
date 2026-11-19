ALTER TABLE "whatsapp_processed_messages" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
-- Markers stored before the lease existed all belong to finished (or deliberately abandoned) handling:
-- count them as completed so the lease never takes them over.
UPDATE "whatsapp_processed_messages" SET "completed_at" = "received_at";
