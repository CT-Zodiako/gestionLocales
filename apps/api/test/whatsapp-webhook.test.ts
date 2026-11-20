import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimWhatsappMessage, sql } from "@gestion/db";
import { WhatsAppSendError } from "../src/whatsapp/client.ts";
import { createServer, type Server } from "../src/server.ts";
import { createWhatsAppRoutes, type WhatsAppStore } from "../src/whatsapp/webhook-routes.ts";
import { authSecret, authUrl, databaseUrl } from "./support/env.ts";
import {
  ACCESS_TOKEN,
  APP_SECRET,
  FakeWhatsAppClient,
  VERIFY_TOKEN,
  newWamid,
  replyPayload,
  sign,
  statusPayload,
  textPayload,
  unsupportedPayload,
} from "./support/whatsapp.ts";
import { WEBHOOK, bodyOf, createHarness, pick, type Harness, type Tenant } from "./support/whatsapp-harness.ts";

const CUSTOMER = "573001234567";

function verifyUrl(params: Record<string, string>): string {
  return `${WEBHOOK}?${new URLSearchParams(params)}`;
}

describe("WhatsApp webhook", () => {
  let harness: Harness;
  let tenant: Tenant;

  beforeAll(async () => {
    harness = await createHarness();
    tenant = await harness.newTenant();
  });

  afterAll(async () => {
    await harness.close();
  });

  const options = (wamid = newWamid(), from = CUSTOMER) => ({ phoneNumberId: tenant.phoneNumberId, from, wamid });
  const sentCount = () => harness.client.sent.length;

  describe("GET verification handshake", () => {
    const valid = { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" };

    it("echoes the challenge as plain text when mode and token are right", async () => {
      const res = await harness.server.app.request(verifyUrl(valid));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("1158201444");
      expect(res.headers.get("content-type")).toContain("text/plain");
    });

    it.each([
      ["a wrong token", { "hub.verify_token": "not-the-token" }],
      ["a token of another length", { "hub.verify_token": `${VERIFY_TOKEN}-longer` }],
      ["an empty token", { "hub.verify_token": "" }],
      ["a missing token", { "hub.verify_token": undefined }],
      ["a wrong mode", { "hub.mode": "unsubscribe" }],
      ["a missing mode", { "hub.mode": undefined }],
      ["a missing challenge", { "hub.challenge": undefined }],
    ])("answers 403 without echoing anything for %s", async (_name, override) => {
      const params = Object.fromEntries(Object.entries({ ...valid, ...override }).filter(([, value]) => value !== undefined)) as Record<string, string>;

      const res = await harness.server.app.request(verifyUrl(params));

      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("1158201444");
    });
  });

  describe("POST signature check", () => {
    const hello = () => textPayload(options(), "hola");

    it.each([
      ["a missing signature", null],
      ["a signature made with another secret", sign(JSON.stringify({ a: 1 }), "another-secret")],
      ["a signature of the wrong length", "sha256=abcd"],
      ["a signature with a non-hex digest of the right length", `sha256=${"g".repeat(64)}`],
      ["a signature with the wrong scheme", `sha1=${"a".repeat(40)}`],
      ["an empty signature", ""],
    ])("answers 401 and does nothing for %s", async (_name, signature) => {
      const before = sentCount();
      const payload = hello();

      const res = await harness.post(payload, { signature });

      expect(res.status).toBe(401);
      expect(sentCount()).toBe(before);
      // Nothing was stored for that message either: the same wamid with a good signature is still processed.
      const retry = await harness.post(payload);
      expect(retry.status).toBe(200);
      expect(sentCount()).toBe(before + 1);
    });

    it("answers 401 for a signature computed over a different body", async () => {
      const before = sentCount();
      const signed = JSON.stringify(textPayload(options(), "hola"));
      const tampered = JSON.stringify(textPayload(options(), "hola")).replace("hola", "adios");

      const res = await harness.post(null, { raw: tampered, signature: sign(signed) });

      expect(res.status).toBe(401);
      expect(sentCount()).toBe(before);
    });

    it("answers 401 when the body has one extra byte after signing", async () => {
      const raw = JSON.stringify(textPayload(options(), "hola"));

      const res = await harness.post(null, { raw: `${raw} `, signature: sign(raw) });

      expect(res.status).toBe(401);
    });

    it("verifies the raw bytes, so a payload with non-ASCII text and odd spacing is accepted", async () => {
      const raw = `{ "object" : "whatsapp_business_account",\n  "entry":[]  , "note":"ñandú ✓ \\u00e9" }`;
      const before = sentCount();

      const res = await harness.post(null, { raw });

      expect(res.status).toBe(200);
      expect(sentCount()).toBe(before);
    });

    it("answers 200 and replies for a correctly signed message", async () => {
      const before = sentCount();

      const res = await harness.post(hello());

      expect(res.status).toBe(200);
      expect(sentCount()).toBe(before + 1);
      expect(harness.client.sent.at(-1)?.phoneNumberId).toBe(tenant.phoneNumberId);
    });

    it("rejects a body over the size limit before processing it", async () => {
      const raw = JSON.stringify({ object: "whatsapp_business_account", padding: "x".repeat(1_100_000) });
      const before = sentCount();

      const res = await harness.post(null, { raw });

      expect(res.status).toBe(413);
      expect(sentCount()).toBe(before);
    });
  });

  describe("payloads that are valid but not actionable", () => {
    it("answers 400 for malformed JSON even with a valid signature, and does nothing", async () => {
      const before = sentCount();

      const res = await harness.post(null, { raw: '{"object": "whatsapp_business_account", ' });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
      expect(sentCount()).toBe(before);
    });

    it.each([["an empty object", {}], ["an array", []], ["a string", "hola"], ["null", null], ["another object type", { object: "page", entry: [{ id: "1" }] }]])(
      "answers 200 and ignores %s",
      async (_name, payload) => {
        const before = sentCount();

        const res = await harness.post(payload);

        expect(res.status).toBe(200);
        expect(sentCount()).toBe(before);
      },
    );

    it("ignores messages for an unknown phone_number_id with 200 and no reply", async () => {
      const before = sentCount();

      const res = await harness.post(textPayload({ phoneNumberId: "999000999000", from: CUSTOMER }, "hola"));

      expect(res.status).toBe(200);
      expect(sentCount()).toBe(before);
    });

    it("ignores status updates (delivery and read receipts)", async () => {
      const before = sentCount();

      const res = await harness.post(statusPayload(tenant.phoneNumberId, CUSTOMER));

      expect(res.status).toBe(200);
      expect(sentCount()).toBe(before);
    });

    it.each(["image", "audio", "video", "document", "location", "sticker", "contacts", "reaction", "order", "button", "unsupported"])(
      "ignores a %s message",
      async (type) => {
        const before = sentCount();

        const res = await harness.post(unsupportedPayload(options(), type));

        expect(res.status).toBe(200);
        expect(sentCount()).toBe(before);
      },
    );

    it("ignores malformed messages (bad sender, missing id, no text) but still handles the good one in the same payload", async () => {
      const before = sentCount();
      const good = newWamid();
      const payload = {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: tenant.phoneNumberId },
                  messages: [
                    { from: "not-a-phone", id: newWamid(), type: "text", text: { body: "hola" } },
                    { from: CUSTOMER, type: "text", text: { body: "hola" } },
                    { from: CUSTOMER, id: newWamid(), type: "text" },
                    { from: CUSTOMER, id: newWamid(), type: "interactive", interactive: { type: "nfm_reply" } },
                    { from: CUSTOMER, id: good, type: "text", text: { body: "hola" } },
                    42,
                    null,
                  ],
                },
              },
              { field: "account_update", value: { metadata: { phone_number_id: tenant.phoneNumberId } } },
            ],
          },
        ],
      };

      const res = await harness.post(payload);

      expect(res.status).toBe(200);
      expect(sentCount()).toBe(before + 1);
    });

    it("handles several messages in one payload, each once", async () => {
      const before = sentCount();
      const make = (from: string) => ({ from, id: newWamid(), type: "text", text: { body: "hola" } });
      const payload = {
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: tenant.phoneNumberId }, messages: [make("573000000001"), make("573000000002")] } }] }],
      };

      expect((await harness.post(payload)).status).toBe(200);
      expect((await harness.post(payload)).status).toBe(200);

      expect(sentCount()).toBe(before + 2);
    });
  });

  describe("idempotency per wamid", () => {
    it("marks a handled message as completed, so a lease can never take it over", async () => {
      const wamid = newWamid();

      const res = await harness.post(textPayload(options(wamid), "hola"));

      expect(res.status).toBe(200);
      const marker = await harness.marker(wamid);
      expect(marker?.businessId).toBe(tenant.businessId);
      expect(marker?.completedAt).toBeInstanceOf(Date);
    });

    it("answers a repeated message once when it is sent again sequentially", async () => {
      const payload = textPayload(options(), "hola");
      const before = sentCount();

      const first = await harness.post(payload);
      const second = await harness.post(payload);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(sentCount()).toBe(before + 1);
    });

    it("books exactly once and sends exactly one confirmation when the same confirmation arrives 10 times concurrently", { timeout: 30_000 }, async () => {
      const phone = "573001110001";
      const customer = tenant.customer(phone);
      const serviceId = tenant.serviceIds[0] ?? "";
      const slotId = `ok:${serviceId}:2031-03-11T14:00:00.000Z`;
      const payload = replyPayload(options(newWamid(), phone), slotId, "button_reply");
      const raw = JSON.stringify(payload);
      const before = customer.inbox().length;

      const responses = await Promise.all(Array.from({ length: 10 }, () => harness.post(null, { raw })));

      expect(responses.map((res) => res.status)).toEqual(Array(10).fill(200));
      const mine = (await tenant.appointments()).filter((appointment) => appointment.customerPhone === phone);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.startsAt.toISOString()).toBe("2031-03-11T14:00:00.000Z");
      const replies = customer.inbox().slice(before);
      expect(replies).toHaveLength(1);
      expect(bodyOf(replies[0]!)).toMatch(/confirmada/i);
    });

    it("books once across a mix of repeats of the same message, sequential and concurrent", async () => {
      const phone = "573001110002";
      const serviceId = tenant.serviceIds[0] ?? "";
      const raw = JSON.stringify(replyPayload(options(newWamid(), phone), `ok:${serviceId}:2031-03-11T15:00:00.000Z`, "button_reply"));

      await harness.post(null, { raw });
      await Promise.all([harness.post(null, { raw }), harness.post(null, { raw })]);
      await harness.post(null, { raw });

      const mine = (await tenant.appointments()).filter((appointment) => appointment.customerPhone === phone);
      expect(mine).toHaveLength(1);
      expect(harness.client.messagesTo(phone)).toHaveLength(1);
    });

    it("cancels exactly once and sends one reply when a cancellation is repeated concurrently", async () => {
      const phone = "573001110003";
      const appointment = await tenant.bookDirect(tenant.serviceIds[0] ?? "", phone, new Date("2031-03-12T14:00:00Z"), 30);
      const raw = JSON.stringify(replyPayload(options(newWamid(), phone), `cancelok:${appointment.id}`, "button_reply"));

      await Promise.all(Array.from({ length: 6 }, () => harness.post(null, { raw })));

      const stored = (await tenant.appointments()).find((row) => row.id === appointment.id);
      expect(stored?.status).toBe("cancelled");
      const replies = harness.client.messagesTo(phone);
      expect(replies).toHaveLength(1);
      expect(bodyOf(replies[0]!)).toMatch(/cancelada/i);
    });

    it("treats a different wamid with the same content as a new message", async () => {
      const before = sentCount();

      await harness.post(textPayload(options(), "hola"));
      await harness.post(textPayload(options(), "hola"));

      expect(sentCount()).toBe(before + 2);
    });
  });

  describe("when the outgoing send fails", () => {
    it("answers 503 and forgets the message when nothing had been changed, so Meta's retry is processed", async () => {
      const payload = textPayload(options(), "hola");
      const raw = JSON.stringify(payload);
      const before = sentCount();
      harness.client.failures = 1;

      const failed = await harness.post(null, { raw });
      const retried = await harness.post(null, { raw });
      const repeated = await harness.post(null, { raw });

      expect(failed.status).toBe(503);
      expect(retried.status).toBe(200);
      expect(repeated.status).toBe(200);
      expect(sentCount()).toBe(before + 1);
    });

    it("keeps the message marked and answers 200 when the booking was already made, so a retry never books twice", async () => {
      const phone = "573001110004";
      const serviceId = tenant.serviceIds[0] ?? "";
      const raw = JSON.stringify(replyPayload(options(newWamid(), phone), `ok:${serviceId}:2031-03-11T15:30:00.000Z`, "button_reply"));
      harness.client.failures = 1;

      const failed = await harness.post(null, { raw });
      const retried = await harness.post(null, { raw });

      expect(failed.status).toBe(200);
      expect(retried.status).toBe(200);
      const mine = (await tenant.appointments()).filter((appointment) => appointment.customerPhone === phone);
      expect(mine).toHaveLength(1);
      expect(harness.client.messagesTo(phone)).toHaveLength(0);
      expect(harness.logs.some((line) => line.startsWith("error") && line.includes("side effect"))).toBe(true);
    });

    it("keeps the message marked when the cancellation was already made", async () => {
      const phone = "573001110005";
      const appointment = await tenant.bookDirect(tenant.serviceIds[0] ?? "", phone, new Date("2031-03-12T15:00:00Z"), 30);
      const raw = JSON.stringify(replyPayload(options(newWamid(), phone), `cancelok:${appointment.id}`, "button_reply"));
      harness.client.failures = 1;

      const failed = await harness.post(null, { raw });
      const retried = await harness.post(null, { raw });

      expect([failed.status, retried.status]).toEqual([200, 200]);
      expect((await tenant.appointments()).find((row) => row.id === appointment.id)?.status).toBe("cancelled");
      expect(harness.client.messagesTo(phone)).toHaveLength(0);
    });

    it("answers 503 and allows the retry when the slot was taken (no change was made)", async () => {
      const phone = "573001110006";
      const serviceId = tenant.serviceIds[0] ?? "";
      await tenant.bookDirect(serviceId, "573001110007", new Date("2031-03-11T14:30:00Z"), 30);
      const raw = JSON.stringify(replyPayload(options(newWamid(), phone), `ok:${serviceId}:2031-03-11T14:30:00.000Z`, "button_reply"));
      harness.client.failures = 1;

      const failed = await harness.post(null, { raw });
      const retried = await harness.post(null, { raw });

      expect(failed.status).toBe(503);
      expect(retried.status).toBe(200);
      expect(harness.client.messagesTo(phone)).toHaveLength(1);
      expect(bodyOf(harness.client.messagesTo(phone)[0]!)).toMatch(/se acaba de ocupar/i);
    });
  });

  describe("logging", () => {
    it("never logs tokens, secrets or full phone numbers", async () => {
      const phone = "573007654321";
      harness.client.failures = 1;
      await harness.post(textPayload(options(newWamid(), phone), "hola"));
      await harness.post(textPayload(options(newWamid(), phone), "hola"));
      await harness.post(textPayload({ phoneNumberId: "999000999001", from: phone }, "hola"));

      const logged = harness.logs.join("\n");

      expect(logged.length).toBeGreaterThan(0);
      for (const secret of [APP_SECRET, VERIFY_TOKEN, ACCESS_TOKEN, phone]) expect(logged).not.toContain(secret);
      expect(logged).toContain("4321");
    });
  });

  describe("unsigned deliveries and the log", () => {
    const warnLines = () => harness.logs.filter((line) => line.startsWith("warn") && line.includes("signature"));

    it("logs at most one warning per minute for rejected deliveries and reports how many it held back", async () => {
      const start = harness.clock.now;
      const before = warnLines().length;
      try {
        for (let n = 0; n < 25; n++) expect((await harness.post({}, { signature: null })).status).toBe(401);
        const firstMinute = warnLines().length - before;

        harness.clock.now = new Date(start.getTime() + 61_000);
        await harness.post({}, { signature: "sha256=abcd" });
        const afterMinute = warnLines();

        expect(firstMinute).toBeLessThanOrEqual(1);
        expect(afterMinute.length - before).toBe(firstMinute + 1);
        const suppressed = Number((afterMinute.at(-1) ?? "").match(/"suppressed":(\d+)/)?.[1]);
        expect(suppressed).toBeGreaterThanOrEqual(25 - firstMinute);
      } finally {
        harness.clock.now = start;
      }
    });

    it("still answers 401 and sends nothing for every one of them", async () => {
      const sent = sentCount();

      const statuses = await Promise.all(Array.from({ length: 10 }, () => harness.post(textPayload(options(), "hola"), { signature: sign("other") }).then((res) => res.status)));

      expect(statuses).toEqual(Array(10).fill(401));
      expect(sentCount()).toBe(sent);
    });
  });

  describe("the session guard", () => {
    it("is not applied to the webhook and still protects every other route", async () => {
      const { app } = harness.server;

      expect((await app.request("/api/me")).status).toBe(401);
      expect((await app.request("/api/services")).status).toBe(401);
      expect((await app.request("/api/appointments?from=2031-03-10T00:00:00Z&to=2031-03-11T00:00:00Z")).status).toBe(401);
      expect((await app.request(verifyUrl({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "x" }))).status).toBe(200);
    });

    it("lets a customer confirm only through the webhook: a session-less booking over the agenda API stays refused", async () => {
      const res = await harness.server.app.request("/api/appointments", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign("{}") },
        body: "{}",
      });

      expect(res.status).toBe(401);
    });
  });
});

describe("WhatsApp webhook when the integration is not configured", () => {
  let server: Server;

  beforeAll(() => {
    server = createServer({ databaseUrl, authSecret, authUrl });
  });

  afterAll(async () => {
    await server.close();
  });

  it("answers 404 to the handshake and to deliveries, signed or not", async () => {
    const raw = JSON.stringify(textPayload({ phoneNumberId: "1", from: "573001234567" }, "hola"));

    const handshake = await server.app.request(verifyUrl({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" }));
    const unsigned = await server.app.request(WEBHOOK, { method: "POST", body: raw });
    const signed = await server.app.request(WEBHOOK, { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });

    expect([handshake.status, unsigned.status, signed.status]).toEqual([404, 404, 404]);
    expect(await handshake.json()).toEqual({ error: "not_found" });
  });

  it("keeps the other routes working", async () => {
    expect((await server.app.request("/api/health")).status).toBe(200);
    expect((await server.app.request("/api/me")).status).toBe(401);
  });
});

describe("createWhatsAppRoutes with an empty secret", () => {
  const unusedStore = {} as WhatsAppStore;

  function routes(overrides: { appSecret?: string; verifyToken?: string }) {
    const client = new FakeWhatsAppClient();
    const app = createWhatsAppRoutes({
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      client,
      store: unusedStore,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      ...overrides,
    });
    return { app, client };
  }

  it("answers 403 to the handshake when verifyToken is empty, even if the caller also sends an empty token", async () => {
    const { app } = routes({ verifyToken: "" });

    const empty = await app.request(`/webhook?${new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "42" })}`);
    const missing = await app.request(`/webhook?${new URLSearchParams({ "hub.mode": "subscribe", "hub.challenge": "42" })}`);

    expect([empty.status, missing.status]).toEqual([403, 403]);
    expect(await empty.text()).not.toContain("42");
  });

  it("answers 401 to a POST when appSecret is empty, even with a signature made with the empty key", async () => {
    const { app, client } = routes({ appSecret: "" });
    const raw = JSON.stringify(textPayload({ phoneNumberId: "1", from: CUSTOMER }, "hola"));

    const forged = await app.request("/webhook", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw, "") } });
    const unsigned = await app.request("/webhook", { method: "POST", body: raw });

    expect([forged.status, unsigned.status]).toEqual([401, 401]);
    expect(client.sent).toEqual([]);
  });

  it("still works with both set (control)", async () => {
    const { app } = routes({});

    const res = await app.request(`/webhook?${new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "42" })}`);

    expect(await res.text()).toBe("42");
  });
});

describe("WhatsApp webhook: lease on the message marker", () => {
  let harness: Harness;
  let tenant: Tenant;

  beforeAll(async () => {
    harness = await createHarness({ controlled: true });
    tenant = await harness.newTenant();
  });

  afterAll(async () => {
    await harness.close();
  });

  const options = (wamid: string, from = "573002220001") => ({ phoneNumberId: tenant.phoneNumberId, from, wamid });
  const sentCount = () => harness.client.sent.length;
  const serviceId = () => tenant.serviceIds[0] ?? "";
  const confirm = (wamid: string, phone: string, startsAt: string) =>
    JSON.stringify(replyPayload(options(wamid, phone), `ok:${serviceId()}:${startsAt}`, "button_reply"));
  const reset = () => {
    harness.controls.leaseMs = 120_000;
    harness.controls.fail.findChannel = 0;
    harness.controls.fail.claimWamids.clear();
    harness.controls.fail.release = 0;
    harness.controls.fail.complete = 0;
    harness.client.failures = 0;
    harness.client.errors = [];
  };

  describe("when the marker release fails after a failure that changed nothing", () => {
    it("keeps an uncompleted marker, treats a retry inside the lease as a duplicate and processes the first retry after it", async () => {
      reset();
      const wamid = newWamid();
      const raw = JSON.stringify(textPayload(options(wamid), "hola"));
      const before = sentCount();
      harness.client.failures = 1;
      harness.controls.fail.release = Number.POSITIVE_INFINITY;
      harness.controls.calls.release = 0;

      const failed = await harness.post(null, { raw });

      expect(failed.status).toBe(503);
      expect(harness.controls.calls.release).toBe(3); // the first attempt plus two retries
      expect(await harness.marker(wamid)).toMatchObject({ completedAt: null });
      expect(harness.logs.some((line) => line.startsWith("error") && line.includes("could not remove the message marker"))).toBe(true);

      const insideLease = await harness.post(null, { raw });
      expect(insideLease.status).toBe(200);
      expect(sentCount()).toBe(before);
      expect(await harness.marker(wamid)).toMatchObject({ completedAt: null });

      harness.controls.leaseMs = 0;
      const afterLease = await harness.post(null, { raw });
      expect(afterLease.status).toBe(200);
      expect(sentCount()).toBe(before + 1);
      expect((await harness.marker(wamid))?.completedAt).toBeInstanceOf(Date);

      const again = await harness.post(null, { raw });
      expect(again.status).toBe(200);
      expect(sentCount()).toBe(before + 1);
    });

    it("retries the release and removes the marker when it succeeds on a later attempt", async () => {
      reset();
      const wamid = newWamid();
      const raw = JSON.stringify(textPayload(options(wamid), "hola"));
      const before = sentCount();
      harness.client.failures = 1;
      harness.controls.fail.release = 2;
      harness.controls.calls.release = 0;

      const failed = await harness.post(null, { raw });

      expect(failed.status).toBe(503);
      expect(harness.controls.calls.release).toBe(3);
      expect(await harness.marker(wamid)).toBeNull();
      expect((await harness.post(null, { raw })).status).toBe(200);
      expect(sentCount()).toBe(before + 1);
    });
  });

  describe("when the process dies after claiming the marker", () => {
    const crash = (wamid: string) => claimWhatsappMessage(harness.server.db, { wamid, businessId: tenant.businessId });

    it("treats the retry inside the lease as a duplicate and processes it once after the lease", async () => {
      reset();
      const wamid = newWamid();
      const phone = "573002220010";
      const raw = confirm(wamid, phone, "2031-03-11T14:00:00.000Z");
      expect(await crash(wamid)).toBe(true);
      const before = harness.client.messagesTo(phone).length;

      expect((await harness.post(null, { raw })).status).toBe(200);
      expect(harness.client.messagesTo(phone)).toHaveLength(before);
      expect((await tenant.appointments()).filter((row) => row.customerPhone === phone)).toHaveLength(0);

      harness.controls.leaseMs = 0;
      expect((await harness.post(null, { raw })).status).toBe(200);
      expect((await harness.post(null, { raw })).status).toBe(200);

      expect((await tenant.appointments()).filter((row) => row.customerPhone === phone)).toHaveLength(1);
      expect(harness.client.messagesTo(phone)).toHaveLength(before + 1);
      expect((await harness.marker(wamid))?.completedAt).toBeInstanceOf(Date);
    });

    it("lets exactly one of 20 concurrent deliveries take the marker over: one booking, one reply", { timeout: 30_000 }, async () => {
      reset();
      const wamid = newWamid();
      const phone = "573002220011";
      const raw = confirm(wamid, phone, "2031-03-13T14:00:00.000Z");
      harness.controls.leaseMs = 10 * 60_000; // far longer than any stall: only the first delivery can take the marker over
      expect(await crash(wamid)).toBe(true);
      await harness.server.db.execute(
        sql`update whatsapp_processed_messages set received_at = now() - interval '1 hour' where wamid = ${wamid}`,
      );
      const handledBefore = harness.logs.filter((line) => line.includes("message handled")).length;

      const responses = await Promise.all(Array.from({ length: 20 }, () => harness.post(null, { raw })));

      expect(responses.map((res) => res.status)).toEqual(Array(20).fill(200));
      expect((await tenant.appointments()).filter((row) => row.customerPhone === phone)).toHaveLength(1);
      expect(harness.client.messagesTo(phone)).toHaveLength(1);
      expect(harness.logs.filter((line) => line.includes("message handled")).length - handledBefore).toBe(1);
      expect((await harness.marker(wamid))?.completedAt).toBeInstanceOf(Date);
    });

    it("never takes over a completed marker, however short the lease", async () => {
      reset();
      const wamid = newWamid();
      const raw = JSON.stringify(textPayload(options(wamid), "hola"));
      const before = sentCount();
      expect((await harness.post(null, { raw })).status).toBe(200);
      harness.controls.leaseMs = 0;

      const repeats = await Promise.all(Array.from({ length: 5 }, () => harness.post(null, { raw })));

      expect(repeats.map((res) => res.status)).toEqual(Array(5).fill(200));
      expect(sentCount()).toBe(before + 1);
    });
  });

  describe("when the reply fails after the agenda was changed", () => {
    it("completes the marker and does not run the bot step again, even after the lease", async () => {
      reset();
      const wamid = newWamid();
      const phone = "573002220020";
      const raw = confirm(wamid, phone, "2031-03-14T14:00:00.000Z");
      harness.client.failures = 1;
      harness.controls.calls.release = 0;

      const failed = await harness.post(null, { raw });
      harness.controls.leaseMs = 0;
      const retried = await harness.post(null, { raw });

      expect([failed.status, retried.status]).toEqual([200, 200]);
      expect(harness.controls.calls.release).toBe(0);
      expect((await tenant.appointments()).filter((row) => row.customerPhone === phone)).toHaveLength(1);
      expect(harness.client.messagesTo(phone)).toHaveLength(0);
      expect((await harness.marker(wamid))?.completedAt).toBeInstanceOf(Date);
    });

    it("also completes it when the failure is permanent", async () => {
      reset();
      const wamid = newWamid();
      const phone = "573002220021";
      const raw = confirm(wamid, phone, "2031-03-14T14:30:00.000Z");
      harness.client.errors = [new WhatsAppSendError(401, 190)];

      const failed = await harness.post(null, { raw });

      expect(failed.status).toBe(200);
      expect((await tenant.appointments()).filter((row) => row.customerPhone === phone)).toHaveLength(1);
      expect((await harness.marker(wamid))?.completedAt).toBeInstanceOf(Date);
    });
  });

  describe("when completing the marker fails after a successful reply", () => {
    it("still answers 200 and leaves the marker uncompleted for the lease instead of releasing it", async () => {
      reset();
      const wamid = newWamid();
      const raw = JSON.stringify(textPayload(options(wamid), "hola"));
      const before = sentCount();
      harness.controls.fail.complete = Number.POSITIVE_INFINITY;
      harness.controls.calls.release = 0;

      const res = await harness.post(null, { raw });

      expect(res.status).toBe(200);
      expect(sentCount()).toBe(before + 1);
      expect(harness.controls.calls.release).toBe(0);
      expect(await harness.marker(wamid)).toMatchObject({ completedAt: null });
      expect(harness.logs.some((line) => line.startsWith("error") && line.includes("could not complete the message marker"))).toBe(true);
    });
  });

  describe("permanent and transient send failures", () => {
    it.each([
      [400, 100],
      [401, 190],
      [403, 10],
      [404, 100],
    ])("answers 200, completes the marker and does not loop on HTTP %i", async (status, graphCode) => {
      reset();
      const wamid = newWamid();
      const raw = JSON.stringify(textPayload(options(wamid), "hola"));
      const before = sentCount();
      harness.client.errors = [new WhatsAppSendError(status, graphCode)];
      harness.controls.calls.release = 0;

      const failed = await harness.post(null, { raw });
      harness.controls.leaseMs = 0;
      const second = await harness.post(null, { raw });

      expect(failed.status).toBe(200);
      expect(second.status).toBe(200);
      expect(sentCount()).toBe(before);
      expect(harness.controls.calls.release).toBe(0);
      expect((await harness.marker(wamid))?.completedAt).toBeInstanceOf(Date);
      const line = harness.logs.findLast((entry) => entry.startsWith("error") && entry.includes(`status ${status}`));
      expect(line).toBeDefined();
      expect(line).toContain("will not be retried");
      for (const secret of [APP_SECRET, VERIFY_TOKEN, ACCESS_TOKEN, "573002220001"]) expect(line).not.toContain(secret);
    });

    it.each<[string, Error]>([
      ["HTTP 500", new WhatsAppSendError(500)],
      ["HTTP 502", new WhatsAppSendError(502)],
      ["HTTP 408", new WhatsAppSendError(408)],
      ["HTTP 429", new WhatsAppSendError(429, 130429)],
      ["a network error", new TypeError("fetch failed")],
      ["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
      ["an unknown error", new Error("boom")],
    ])("answers 503 and releases the marker on %s, so Meta's retry is processed", async (_name, error) => {
      reset();
      const wamid = newWamid();
      const raw = JSON.stringify(textPayload(options(wamid), "hola"));
      const before = sentCount();
      harness.client.errors = [error];

      const failed = await harness.post(null, { raw });

      expect(failed.status).toBe(503);
      expect(await harness.marker(wamid)).toBeNull();
      expect((await harness.post(null, { raw })).status).toBe(200);
      expect(sentCount()).toBe(before + 1);
      expect((await harness.marker(wamid))?.completedAt).toBeInstanceOf(Date);
    });
  });

  describe("when the store itself fails", () => {
    it("answers 503 when the channel lookup throws and processes the retry", async () => {
      reset();
      const wamid = newWamid();
      const raw = JSON.stringify(textPayload(options(wamid), "hola"));
      const before = sentCount();
      harness.controls.fail.findChannel = 1;

      const failed = await harness.post(null, { raw });

      expect(failed.status).toBe(503);
      expect(sentCount()).toBe(before);
      expect(await harness.marker(wamid)).toBeNull();
      expect((await harness.post(null, { raw })).status).toBe(200);
      expect(sentCount()).toBe(before + 1);
    });

    it("answers 503 when a claim throws, and a retry deduplicates the messages that were already handled", async () => {
      reset();
      const [first, second] = [newWamid(), newWamid()];
      const [phoneA, phoneB] = ["573002220030", "573002220031"];
      const message = (id: string, from: string) => ({ from, id, type: "text", text: { body: "hola" } });
      const raw = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: tenant.phoneNumberId }, messages: [message(first, phoneA), message(second, phoneB)] } }] }],
      });
      harness.controls.fail.claimWamids.add(second);

      const failed = await harness.post(null, { raw });

      expect(failed.status).toBe(503);
      expect(harness.client.messagesTo(phoneA)).toHaveLength(1);
      expect(harness.client.messagesTo(phoneB)).toHaveLength(0);
      expect(await harness.marker(second)).toBeNull();

      harness.controls.fail.claimWamids.clear();
      harness.controls.leaseMs = 0;
      const retried = await harness.post(null, { raw });

      expect(retried.status).toBe(200);
      expect(harness.client.messagesTo(phoneA)).toHaveLength(1);
      expect(harness.client.messagesTo(phoneB)).toHaveLength(1);
      expect((await harness.marker(first))?.completedAt).toBeInstanceOf(Date);
      expect((await harness.marker(second))?.completedAt).toBeInstanceOf(Date);
    });
  });
});
