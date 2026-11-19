import { createHmac, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { OutgoingMessage } from "../../src/whatsapp/messages.ts";
import type { WhatsAppClient } from "../../src/whatsapp/client.ts";

/** Throwaway constants: tests never use or read real credentials. */
export const APP_SECRET = "throwaway-app-secret-for-tests";
export const VERIFY_TOKEN = "throwaway-verify-token-for-tests";
export const ACCESS_TOKEN = "throwaway-access-token-for-tests";

/** `X-Hub-Signature-256` value for a raw body. */
export function sign(rawBody: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** WhatsApp Cloud API limits, written out independently of the code under test. */
export const LIMITS = {
  textBody: 4096,
  interactiveBody: 1024,
  header: 60,
  footer: 60,
  buttonTitle: 20,
  buttonId: 256,
  maxButtons: 3,
  listButton: 20,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  maxRows: 10,
} as const;

/** Fails the test when a message exceeds any WhatsApp limit. */
export function assertWithinLimits(message: OutgoingMessage): void {
  expect(message.messaging_product).toBe("whatsapp");
  expect(message.to).toMatch(/^\d{8,15}$/);

  if (message.type === "text") {
    expect(message.text.body.length).toBeGreaterThan(0);
    expect(message.text.body.length).toBeLessThanOrEqual(LIMITS.textBody);
    return;
  }

  const { interactive } = message;
  expect(interactive.body.text.length).toBeGreaterThan(0);
  expect(interactive.body.text.length).toBeLessThanOrEqual(LIMITS.interactiveBody);
  if (interactive.footer) expect(interactive.footer.text.length).toBeLessThanOrEqual(LIMITS.footer);

  if (interactive.type === "button") {
    const { buttons } = interactive.action;
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    expect(buttons.length).toBeLessThanOrEqual(LIMITS.maxButtons);
    for (const button of buttons) {
      expect(button.reply.title.length).toBeGreaterThan(0);
      expect(button.reply.title.length).toBeLessThanOrEqual(LIMITS.buttonTitle);
      expect(button.reply.id.length).toBeLessThanOrEqual(LIMITS.buttonId);
    }
    expect(new Set(buttons.map((button) => button.reply.id)).size).toBe(buttons.length);
    return;
  }

  if (interactive.header) expect(interactive.header.text.length).toBeLessThanOrEqual(LIMITS.header);
  expect(interactive.action.button.length).toBeLessThanOrEqual(LIMITS.listButton);
  const rows = interactive.action.sections.flatMap((section) => section.rows);
  for (const section of interactive.action.sections) {
    if (section.title !== undefined) expect(section.title.length).toBeLessThanOrEqual(LIMITS.sectionTitle);
  }
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows.length).toBeLessThanOrEqual(LIMITS.maxRows);
  for (const row of rows) {
    expect(row.title.length).toBeGreaterThan(0);
    expect(row.title.length).toBeLessThanOrEqual(LIMITS.rowTitle);
    expect(row.id.length).toBeLessThanOrEqual(LIMITS.rowId);
    if (row.description !== undefined) expect(row.description.length).toBeLessThanOrEqual(LIMITS.rowDescription);
  }
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
}

export interface SentMessage {
  phoneNumberId: string;
  message: OutgoingMessage;
}

/** Records every outgoing message, checks WhatsApp limits on each one and can be told to fail. */
export class FakeWhatsAppClient implements WhatsAppClient {
  readonly sent: SentMessage[] = [];
  /** Number of upcoming `sendMessage` calls that reject. */
  failures = 0;

  async sendMessage(input: SentMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("simulated send failure");
    }
    assertWithinLimits(input.message);
    this.sent.push(input);
  }

  messagesTo(phone: string): OutgoingMessage[] {
    return this.sent.filter((entry) => entry.message.to === phone).map((entry) => entry.message);
  }
}

export interface PayloadOptions {
  phoneNumberId: string;
  from: string;
  wamid?: string;
}

function envelope(phoneNumberId: string, value: Record<string, unknown>): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export function newWamid(): string {
  return `wamid.${randomUUID()}`;
}

export function textPayload(options: PayloadOptions, body: string): Record<string, unknown> {
  return envelope(options.phoneNumberId, {
    contacts: [{ profile: { name: "Cliente" }, wa_id: options.from }],
    messages: [{ from: options.from, id: options.wamid ?? newWamid(), timestamp: "1900000000", type: "text", text: { body } }],
  });
}

export type ReplyKind = "button_reply" | "list_reply";

/** The customer tapped a reply button or picked a list row. */
export function replyPayload(options: PayloadOptions, replyId: string, kind: ReplyKind = "list_reply"): Record<string, unknown> {
  return envelope(options.phoneNumberId, {
    contacts: [{ profile: { name: "Cliente" }, wa_id: options.from }],
    messages: [
      {
        from: options.from,
        id: options.wamid ?? newWamid(),
        timestamp: "1900000000",
        type: "interactive",
        interactive: { type: kind, [kind]: { id: replyId, title: "ignored" } },
      },
    ],
  });
}

/** A delivery/read receipt for a message the business sent. */
export function statusPayload(phoneNumberId: string, recipient: string): Record<string, unknown> {
  return envelope(phoneNumberId, {
    statuses: [{ id: newWamid(), status: "delivered", timestamp: "1900000000", recipient_id: recipient }],
  });
}

/** A message of a type the bot does not handle (image, audio, location, ...). */
export function unsupportedPayload(options: PayloadOptions, type: string): Record<string, unknown> {
  return envelope(options.phoneNumberId, {
    contacts: [{ profile: { name: "Cliente" }, wa_id: options.from }],
    messages: [{ from: options.from, id: options.wamid ?? newWamid(), timestamp: "1900000000", type, [type]: { id: "media-id" } }],
  });
}
