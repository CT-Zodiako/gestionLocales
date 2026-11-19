import { createDb } from "@gestion/db";
import { parseArgs } from "./cli-args.ts";
import { linkWhatsappNumber, type LinkWhatsappResult } from "./link-whatsapp.ts";

const USAGE = `Registers a WhatsApp phone_number_id for the business of an owner.

Usage:
  pnpm whatsapp:link --email <owner email> --phone-number-id <id>

Both options fall back to env vars, so this works too:
  AUTH_EMAIL=... WHATSAPP_PHONE_NUMBER_ID=... pnpm whatsapp:link

The phone number id is the "Phone number ID" shown in Meta's WhatsApp > API Setup page (digits only).
It is idempotent: linking the same number to the same business again changes nothing. A number that
already belongs to another business is refused.

Required env var: DATABASE_URL.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if ("help" in args || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const email = args.email || process.env.AUTH_EMAIL;
if (!email) fail(`Missing value: --email (AUTH_EMAIL)\n\n${USAGE}`);
const phoneNumberId = args["phone-number-id"] || process.env.WHATSAPP_PHONE_NUMBER_ID;
if (!phoneNumberId) fail(`Missing value: --phone-number-id (WHATSAPP_PHONE_NUMBER_ID)\n\n${USAGE}`);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("Missing environment variable: DATABASE_URL");

const database = createDb(databaseUrl);
let result: LinkWhatsappResult;
try {
  result = await linkWhatsappNumber(database.db, { email, phoneNumberId });
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  fail(`Could not link the WhatsApp number: ${reason.replace(/\s+/g, " ").trim()}`);
} finally {
  await database.close();
}

switch (result.status) {
  case "linked":
    console.log(`WhatsApp number linked: ${phoneNumberId}`);
    console.log(`Business id: ${result.businessId}`);
    break;
  case "already_linked":
    console.log(`WhatsApp number already linked: ${phoneNumberId}`);
    console.log(`Business id: ${result.businessId}`);
    break;
  case "other_business":
    fail(`The WhatsApp number ${phoneNumberId} is already linked to another business; nothing was changed.`);
    break;
  case "no_owner":
    fail(`No owner found with the email ${email}. Create it first with pnpm auth:create-user.`);
    break;
  case "no_business":
    fail(`The owner ${email} has no business yet. Run pnpm auth:create-user again to link it.`);
    break;
  case "invalid_phone_number_id":
    fail("The phone number id must be 5 to 32 digits (copy the \"Phone number ID\" from Meta's API Setup page).");
    break;
}
