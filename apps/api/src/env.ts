/** Dev-only fallback; production refuses to start without BETTER_AUTH_SECRET. */
export const DEV_AUTH_SECRET = "dev-only-better-auth-secret-change-me-0123456789";

/** Graph API version used when `WHATSAPP_API_VERSION` is unset. */
export const DEFAULT_WHATSAPP_API_VERSION = "v23.0";

/** Real Graph API host; `WHATSAPP_API_BASE_URL` overrides it (for a local stub in smoke tests). */
export const DEFAULT_WHATSAPP_API_BASE_URL = "https://graph.facebook.com";

/** Present only when the WhatsApp integration is configured. */
export type WhatsAppEnv = {
  /** WHATSAPP_APP_SECRET: signs deliveries (X-Hub-Signature-256). */
  appSecret: string;
  /** WHATSAPP_VERIFY_TOKEN: the subscription handshake token. */
  verifyToken: string;
  /** WHATSAPP_TOKEN: Bearer token for sending messages. */
  accessToken: string;
  apiVersion: string;
  apiBaseUrl: string;
  /** WHATSAPP_PHONE_NUMBER_ID: informational here; `pnpm whatsapp:link` uses it as the default number. */
  phoneNumberId?: string;
};

export type ApiEnv = {
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
  port: number;
  runMigrations: boolean;
  /** Absent when WhatsApp is not configured: the webhook routes then answer 404. */
  whatsapp?: WhatsAppEnv;
};

const WHATSAPP_REQUIRED = ["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_TOKEN"] as const;

/** Unset and blank are the same: docker compose passes unset variables as empty strings. */
function read(source: Record<string, string | undefined>, name: string): string | undefined {
  const value = source[name]?.trim();
  return value ? value : undefined;
}

/**
 * Reads the WhatsApp variables. All three required ones unset disables the integration; some but not all
 * is a configuration mistake and throws (names only, never values) instead of half-working.
 */
function readWhatsAppEnv(source: Record<string, string | undefined>): WhatsAppEnv | undefined {
  const present = WHATSAPP_REQUIRED.filter((name) => read(source, name) !== undefined);
  if (present.length === 0) return undefined;

  const missing = WHATSAPP_REQUIRED.filter((name) => read(source, name) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Incomplete WhatsApp configuration: ${WHATSAPP_REQUIRED.join(", ")} must all be set or all be unset (missing: ${missing.join(", ")})`,
    );
  }

  const apiVersion = read(source, "WHATSAPP_API_VERSION") ?? DEFAULT_WHATSAPP_API_VERSION;
  if (!/^v\d+\.\d+$/.test(apiVersion)) throw new Error("WHATSAPP_API_VERSION must look like v23.0");

  const baseUrl = read(source, "WHATSAPP_API_BASE_URL") ?? DEFAULT_WHATSAPP_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("WHATSAPP_API_BASE_URL must be an http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("WHATSAPP_API_BASE_URL must be an http(s) URL");

  const phoneNumberId = read(source, "WHATSAPP_PHONE_NUMBER_ID");
  return {
    appSecret: read(source, "WHATSAPP_APP_SECRET") ?? "",
    verifyToken: read(source, "WHATSAPP_VERIFY_TOKEN") ?? "",
    accessToken: read(source, "WHATSAPP_TOKEN") ?? "",
    apiVersion,
    apiBaseUrl: baseUrl.replace(/\/+$/, ""),
    ...(phoneNumberId === undefined ? {} : { phoneNumberId }),
  };
}

/** Reads and validates the API environment, throwing a readable message. */
export function readApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const port = Number(source.PORT ?? 3000);
  const isProduction = source.NODE_ENV === "production";
  const authSecret = source.BETTER_AUTH_SECRET || (isProduction ? "" : DEV_AUTH_SECRET);
  if (!authSecret) throw new Error("BETTER_AUTH_SECRET is required when NODE_ENV=production");

  const whatsapp = readWhatsAppEnv(source);

  return {
    databaseUrl,
    authSecret,
    authUrl: source.BETTER_AUTH_URL || `http://localhost:${port}`,
    port,
    runMigrations: source.RUN_MIGRATIONS === "true",
    ...(whatsapp ? { whatsapp } : {}),
  };
}
