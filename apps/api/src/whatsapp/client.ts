import type { OutgoingMessage } from "./messages.ts";

/** Graph API host; `WHATSAPP_API_BASE_URL` overrides it (a local stub in smoke tests). */
export const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";

/** Sends messages through the WhatsApp Cloud API; replaceable in tests. */
export interface WhatsAppClient {
  /** Sends `message` from the business number `phoneNumberId`; rejects when WhatsApp does not accept it. */
  sendMessage: (input: { phoneNumberId: string; message: OutgoingMessage }) => Promise<void>;
}

/** The Graph API refused a message, or could not be reached. Its message never holds the token or the recipient. */
export class WhatsAppSendError extends Error {
  readonly status: number;

  constructor(status: number, graphCode?: number) {
    super(`WhatsApp send failed with status ${status}${graphCode === undefined ? "" : ` (Graph error code ${graphCode})`}`);
    this.name = "WhatsAppSendError";
    this.status = status;
  }
}

/**
 * True when resending the same message cannot succeed: the Graph API answered with a 4xx other than
 * 408 (request timeout) and 429 (rate limit), such as an invalid or expired token (401/403), a rejected
 * message body (400) or an unknown phone number id (404). Network errors, timeouts, 5xx, 408, 429 and
 * anything that is not a `WhatsAppSendError` are transient.
 */
export function isPermanentSendError(error: unknown): boolean {
  if (!(error instanceof WhatsAppSendError)) return false;
  const { status } = error;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export interface FetchClientOptions {
  /** WHATSAPP_TOKEN: sent as a Bearer token, never logged. */
  token: string;
  /** For example `v23.0`. */
  apiVersion: string;
  baseUrl?: string;
  /** Replaceable `fetch`, for tests. */
  fetch?: typeof fetch;
  /** Abort a request after this many milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

function graphErrorCode(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const { error } = body;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

/** The real client: `POST {base}/{version}/{phone_number_id}/messages` with a Bearer token. */
export function createFetchWhatsAppClient(options: FetchClientOptions): WhatsAppClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, "");

  return {
    async sendMessage({ phoneNumberId, message }) {
      if (!/^\d{1,32}$/.test(phoneNumberId)) throw new Error("Invalid phone number id");

      const response = await fetchImpl(`${baseUrl}/${options.apiVersion}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }

      const body: unknown = await response.json().catch(() => undefined);
      throw new WhatsAppSendError(response.status, graphErrorCode(body));
    },
  };
}
