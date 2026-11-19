import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * Checks Meta's `X-Hub-Signature-256` header: `sha256=` + the hex HMAC-SHA256 of the RAW request body
 * keyed with the app secret. The digest is compared in constant time (`timingSafeEqual`) and only after
 * the header is known to be exactly 64 hex digits, so lengths never leak and nothing throws.
 */
export function verifySignature(appSecret: string, rawBody: Uint8Array, header: string | undefined | null): boolean {
  if (!appSecret || !header || !header.startsWith(PREFIX)) return false;

  const digest = header.slice(PREFIX.length);
  if (!HEX_SHA256.test(digest)) return false;

  const received = Buffer.from(digest, "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Constant-time equality of two strings of any length (both are hashed first). */
export function safeEqual(a: string, b: string): boolean {
  const left = createHmac("sha256", "compare").update(a).digest();
  const right = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(left, right);
}
