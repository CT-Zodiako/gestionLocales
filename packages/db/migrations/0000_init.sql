CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/Bogota' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
