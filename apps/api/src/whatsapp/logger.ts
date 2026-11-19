/** Minimal logger the WhatsApp integration writes to; tests capture it, production uses the console. */
export interface WhatsAppLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

export const consoleLogger: WhatsAppLogger = {
  info: (message, fields) => console.log(`[whatsapp] ${message}`, fields ?? ""),
  warn: (message, fields) => console.warn(`[whatsapp] ${message}`, fields ?? ""),
  error: (message, fields) => console.error(`[whatsapp] ${message}`, fields ?? ""),
};

/** `573001234567` becomes `***4567`: enough to correlate a conversation, not enough to identify the person. */
export function maskPhone(phone: string): string {
  return `***${phone.slice(-4)}`;
}

/**
 * A log-safe description of an error. Database and HTTP errors can carry query parameters (phone numbers)
 * or response bodies, so only the error name, a Postgres code and the message of our own send error are kept.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  if (error.name === "WhatsAppSendError") return error.message;

  const code = findCode(error);
  return code ? `${error.name} (code ${code})` : error.name;
}

function findCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
