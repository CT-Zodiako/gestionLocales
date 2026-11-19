import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../src/whatsapp/signature.ts";

const SECRET = "throwaway-signature-secret";
const BODY = Buffer.from('{"object":"whatsapp_business_account","text":"ñandú ✓"}', "utf8");

function header(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifySignature", () => {
  it("accepts the HMAC-SHA256 of the raw bytes, in lower or upper case hex", () => {
    expect(verifySignature(SECRET, BODY, header(BODY))).toBe(true);
    expect(verifySignature(SECRET, BODY, `sha256=${header(BODY).slice("sha256=".length).toUpperCase()}`)).toBe(true);
  });

  it("rejects a missing header, another secret, another body and a wrong prefix", () => {
    expect(verifySignature(SECRET, BODY, undefined)).toBe(false);
    expect(verifySignature(SECRET, BODY, "")).toBe(false);
    expect(verifySignature(SECRET, BODY, header(BODY, "another-secret"))).toBe(false);
    expect(verifySignature(SECRET, Buffer.from(`${BODY.toString()} `), header(BODY))).toBe(false);
    expect(verifySignature(SECRET, BODY, header(BODY).replace("sha256=", "sha1="))).toBe(false);
    expect(verifySignature(SECRET, BODY, header(BODY).slice("sha256=".length))).toBe(false);
  });

  it("rejects wrong lengths and non-hex digests without throwing", () => {
    const valid = header(BODY);
    expect(verifySignature(SECRET, BODY, valid.slice(0, -2))).toBe(false);
    expect(verifySignature(SECRET, BODY, `${valid}00`)).toBe(false);
    expect(verifySignature(SECRET, BODY, "sha256=")).toBe(false);
    expect(verifySignature(SECRET, BODY, `sha256=${"z".repeat(64)}`)).toBe(false);
    expect(verifySignature(SECRET, BODY, `sha256=${"é".repeat(64)}`)).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    expect(verifySignature("", BODY, header(BODY, ""))).toBe(false);
  });
});
