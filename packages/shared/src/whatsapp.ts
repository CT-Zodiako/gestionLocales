import { z } from "zod";
import { phoneSchema } from "./agenda.ts";

/**
 * What the bot understands from an incoming WhatsApp message: free text, or the id of the reply button
 * or list row the customer tapped. Every other message type is ignored.
 */
export const INCOMING_KIND = {
  TEXT: "text",
  REPLY: "reply",
} as const;

export interface IncomingText {
  kind: typeof INCOMING_KIND.TEXT;
  body: string;
}

export interface IncomingReply {
  kind: typeof INCOMING_KIND.REPLY;
  /** The id the bot attached to the button or row. Client-controlled: validate it on every use. */
  id: string;
}

export type IncomingContent = IncomingText | IncomingReply;

/** One actionable message of a webhook delivery. */
export interface IncomingMessage {
  /** WhatsApp message id, the idempotency key. */
  wamid: string;
  /** Sender number, digits only (what `customers.phone` stores). */
  from: string;
  content: IncomingContent;
}

/** The messages of a webhook delivery that belong to one of the business's phone numbers. */
export interface IncomingBatch {
  /** Meta's `phone_number_id` of the number that received them. */
  phoneNumberId: string;
  messages: IncomingMessage[];
}

const messageBaseSchema = z.object({
  from: phoneSchema,
  id: z.string().min(1).max(255),
});

const textMessageSchema = messageBaseSchema.extend({
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});

const interactiveMessageSchema = messageBaseSchema.extend({
  type: z.literal("interactive"),
  interactive: z.union([
    z.object({ type: z.literal("button_reply"), button_reply: z.object({ id: z.string() }) }),
    z.object({ type: z.literal("list_reply"), list_reply: z.object({ id: z.string() }) }),
  ]),
});

const changeSchema = z.object({
  field: z.string().optional(),
  value: z.object({
    metadata: z.object({ phone_number_id: z.string().min(1).max(64) }),
    messages: z.array(z.unknown()).optional(),
  }),
});

const deliverySchema = z.object({
  object: z.string().optional(),
  entry: z.array(z.object({ changes: z.array(z.unknown()).optional() })),
});

function toMessage(candidate: unknown): IncomingMessage | null {
  const text = textMessageSchema.safeParse(candidate);
  if (text.success) {
    return { wamid: text.data.id, from: text.data.from, content: { kind: INCOMING_KIND.TEXT, body: text.data.text.body } };
  }

  const interactive = interactiveMessageSchema.safeParse(candidate);
  if (interactive.success) {
    const reply = interactive.data.interactive;
    const id = reply.type === "button_reply" ? reply.button_reply.id : reply.list_reply.id;
    return { wamid: interactive.data.id, from: interactive.data.from, content: { kind: INCOMING_KIND.REPLY, id } };
  }

  return null;
}

/**
 * Extracts the actionable messages (text and interactive replies) from a webhook delivery, grouped by the
 * phone number that received them. Anything else is dropped without failing the rest of the delivery:
 * status updates, other change fields, unsupported message types, malformed entries and senders whose
 * number is not 8 to 15 digits.
 */
export function extractIncomingBatches(payload: unknown): IncomingBatch[] {
  const delivery = deliverySchema.safeParse(payload);
  if (!delivery.success || (delivery.data.object !== undefined && delivery.data.object !== "whatsapp_business_account")) {
    return [];
  }

  const batches: IncomingBatch[] = [];
  for (const entry of delivery.data.entry) {
    for (const rawChange of entry.changes ?? []) {
      const change = changeSchema.safeParse(rawChange);
      if (!change.success || (change.data.field !== undefined && change.data.field !== "messages")) continue;

      const messages = (change.data.value.messages ?? []).flatMap((candidate) => {
        const message = toMessage(candidate);
        return message ? [message] : [];
      });
      if (messages.length > 0) batches.push({ phoneNumberId: change.data.value.metadata.phone_number_id, messages });
    }
  }
  return batches;
}
