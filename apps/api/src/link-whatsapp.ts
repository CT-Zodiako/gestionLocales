import { findUserByEmail, linkWhatsappChannel, type Database } from "@gestion/db";

/** Meta's phone_number_id: a numeric string. */
export const PHONE_NUMBER_ID_PATTERN = /^\d{5,32}$/;

export type LinkWhatsappResult =
  | { status: "linked"; businessId: string }
  | { status: "already_linked"; businessId: string }
  | { status: "other_business" }
  | { status: "no_owner" }
  | { status: "no_business" }
  | { status: "invalid_phone_number_id" };

/**
 * Registers a WhatsApp `phone_number_id` for the business of the owner with that email, so webhook messages
 * for that number reach the business. Idempotent; a number that belongs to another business is never reassigned.
 */
export async function linkWhatsappNumber(
  db: Database,
  input: { email: string; phoneNumberId: string },
): Promise<LinkWhatsappResult> {
  if (!PHONE_NUMBER_ID_PATTERN.test(input.phoneNumberId)) return { status: "invalid_phone_number_id" };

  const owner = await findUserByEmail(db, input.email.trim().toLowerCase());
  if (!owner) return { status: "no_owner" };
  if (!owner.businessId) return { status: "no_business" };

  const result = await linkWhatsappChannel(db, owner.businessId, input.phoneNumberId);
  if (result === "other_business") return { status: "other_business" };
  return { status: result, businessId: owner.businessId };
}
