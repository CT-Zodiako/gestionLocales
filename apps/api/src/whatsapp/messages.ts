/** WhatsApp Cloud API limits for the message shapes the bot sends. */
export const WHATSAPP_LIMITS = {
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

const ELLIPSIS = "…";

/**
 * Collapses whitespace (titles cannot hold line breaks) and cuts the text to `max` UTF-16 units,
 * ending in an ellipsis when something was cut. Never splits a surrogate pair.
 */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;

  let result = "";
  for (const character of clean) {
    if (result.length + character.length > max - ELLIPSIS.length) break;
    result += character;
  }
  return `${result.trimEnd()}${ELLIPSIS}`;
}

/** Like `truncate` for message bodies: keeps line breaks, only cuts. */
function truncateBody(text: string, max: number): string {
  if (text.length <= max) return text;

  let result = "";
  for (const character of text) {
    if (result.length + character.length > max - ELLIPSIS.length) break;
    result += character;
  }
  return `${result.trimEnd()}${ELLIPSIS}`;
}

interface MessageBase {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  /** Recipient number, digits only. */
  to: string;
}

export interface TextMessage extends MessageBase {
  type: "text";
  text: { body: string; preview_url: false };
}

export interface ReplyButton {
  type: "reply";
  reply: { id: string; title: string };
}

export interface ButtonsInteractive {
  type: "button";
  body: { text: string };
  footer?: { text: string };
  action: { buttons: ReplyButton[] };
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title?: string;
  rows: ListRow[];
}

export interface ListInteractive {
  type: "list";
  header?: { type: "text"; text: string };
  body: { text: string };
  footer?: { text: string };
  action: { button: string; sections: ListSection[] };
}

export interface InteractiveMessage extends MessageBase {
  type: "interactive";
  interactive: ButtonsInteractive | ListInteractive;
}

/** A message in the exact shape the Graph API `/messages` endpoint takes. */
export type OutgoingMessage = TextMessage | InteractiveMessage;

/** A pre-approved template message: the only kind WhatsApp lets a business start outside the 24 h customer window. */
export interface TemplateMessage extends MessageBase {
  type: "template";
  template: {
    name: string;
    language: { code: string };
    components: Array<{ type: "body"; parameters: Array<{ type: "text"; text: string }> }>;
  };
}

export interface TemplateMessageInput {
  to: string;
  /** Template name as approved in Meta Business Manager. */
  name: string;
  /** Template language code, for example `es`. */
  language: string;
  /** Values of the body variables `{{1}}`, `{{2}}`, ... in order. */
  bodyParameters: string[];
}

export function templateMessage(input: TemplateMessageInput): TemplateMessage {
  return {
    ...base(input.to),
    type: "template",
    template: {
      name: input.name,
      language: { code: input.language },
      components: [{ type: "body", parameters: input.bodyParameters.map((text) => ({ type: "text", text })) }],
    },
  };
}

function base(to: string): MessageBase {
  return { messaging_product: "whatsapp", recipient_type: "individual", to };
}

export function textMessage(to: string, body: string): TextMessage {
  return { ...base(to), type: "text", text: { body: truncateBody(body, WHATSAPP_LIMITS.textBody), preview_url: false } };
}

export interface ButtonInput {
  id: string;
  title: string;
}

export interface ButtonsMessageInput {
  to: string;
  body: string;
  footer?: string;
  buttons: ButtonInput[];
}

/** Reply buttons: 1 to 3, titles cut to 20 characters. Ids come from the bot and are checked, not cut. */
export function buttonsMessage(input: ButtonsMessageInput): InteractiveMessage {
  if (input.buttons.length < 1 || input.buttons.length > WHATSAPP_LIMITS.maxButtons) {
    throw new RangeError(`A reply-button message needs 1 to ${WHATSAPP_LIMITS.maxButtons} buttons`);
  }
  for (const button of input.buttons) {
    if (button.id.length > WHATSAPP_LIMITS.buttonId) throw new RangeError("Button id is too long");
  }

  const interactive: ButtonsInteractive = {
    type: "button",
    body: { text: truncateBody(input.body, WHATSAPP_LIMITS.interactiveBody) },
    action: {
      buttons: input.buttons.map(
        (button): ReplyButton => ({
          type: "reply",
          reply: { id: button.id, title: truncate(button.title, WHATSAPP_LIMITS.buttonTitle) },
        }),
      ),
    },
  };
  if (input.footer) interactive.footer = { text: truncate(input.footer, WHATSAPP_LIMITS.footer) };
  return { ...base(input.to), type: "interactive", interactive };
}

export interface ListRowInput {
  id: string;
  title: string;
  description?: string;
}

export interface ListMessageInput {
  to: string;
  header?: string;
  body: string;
  footer?: string;
  /** Label of the button that opens the list. */
  buttonLabel: string;
  sectionTitle?: string;
  rows: ListRowInput[];
}

/** A list with one section: 1 to 10 rows with unique ids; titles, descriptions and the rest are cut to their limits. */
export function listMessage(input: ListMessageInput): InteractiveMessage {
  if (input.rows.length < 1 || input.rows.length > WHATSAPP_LIMITS.maxRows) {
    throw new RangeError(`A list message needs 1 to ${WHATSAPP_LIMITS.maxRows} rows`);
  }
  if (new Set(input.rows.map((row) => row.id)).size !== input.rows.length) throw new RangeError("List row ids must be unique");
  for (const row of input.rows) {
    if (row.id.length > WHATSAPP_LIMITS.rowId) throw new RangeError("List row id is too long");
  }

  const rows = input.rows.map((row): ListRow => {
    const result: ListRow = { id: row.id, title: truncate(row.title, WHATSAPP_LIMITS.rowTitle) };
    if (row.description) result.description = truncate(row.description, WHATSAPP_LIMITS.rowDescription);
    return result;
  });
  const section: ListSection = { rows };
  if (input.sectionTitle) section.title = truncate(input.sectionTitle, WHATSAPP_LIMITS.sectionTitle);

  const interactive: ListInteractive = {
    type: "list",
    body: { text: truncateBody(input.body, WHATSAPP_LIMITS.interactiveBody) },
    action: { button: truncate(input.buttonLabel, WHATSAPP_LIMITS.listButton), sections: [section] },
  };
  if (input.header) interactive.header = { type: "text", text: truncate(input.header, WHATSAPP_LIMITS.header) };
  if (input.footer) interactive.footer = { text: truncate(input.footer, WHATSAPP_LIMITS.footer) };
  return { ...base(input.to), type: "interactive", interactive };
}
