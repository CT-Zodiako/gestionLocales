import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { claimWhatsappMessage, findWhatsappChannel, releaseWhatsappMessage } from "@gestion/db";
import { extractIncomingBatches, type ErrorResponse, type IncomingBatch, type IncomingMessage } from "@gestion/shared";
import { handleIncoming, type BotStore, type EffectTracker } from "./bot.ts";
import type { WhatsAppClient } from "./client.ts";
import { consoleLogger, describeError, maskPhone, type WhatsAppLogger } from "./logger.ts";
import { safeEqual, verifySignature } from "./signature.ts";

/** A data-layer function with its leading `db` argument already bound. */
type Bound<F> = F extends (db: never, ...args: infer Args) => infer Result ? (...args: Args) => Result : never;

/** What the webhook needs from the database: the bot's store plus routing and idempotency. */
export interface WhatsAppStore extends BotStore {
  findChannel: Bound<typeof findWhatsappChannel>;
  claimMessage: Bound<typeof claimWhatsappMessage>;
  releaseMessage: Bound<typeof releaseWhatsappMessage>;
}

export interface WhatsAppWebhookDeps {
  /** WHATSAPP_APP_SECRET: keys the HMAC of every delivery. */
  appSecret: string;
  /** WHATSAPP_VERIFY_TOKEN: the shared secret of the subscription handshake. */
  verifyToken: string;
  client: WhatsAppClient;
  store: WhatsAppStore;
  logger?: WhatsAppLogger;
  /** Clock; replaced in tests so dates are deterministic. */
  now?: () => Date;
}

/** Rejected deliveries are logged at most once per this long; the rest are only counted. */
const REJECTION_LOG_INTERVAL_MS = 60_000;

/** Meta's deliveries are a few KB; anything this big is not one. */
const MAX_BODY_BYTES = 1024 * 1024;

const invalidRequest = { error: "invalid_request" } satisfies ErrorResponse;
const invalidSignature = { error: "invalid_signature" } satisfies ErrorResponse;
const forbidden = { error: "forbidden" } satisfies ErrorResponse;
const unavailable = { error: "temporarily_unavailable" } satisfies ErrorResponse;
const tooLarge = { error: "payload_too_large" } satisfies ErrorResponse;

type Outcome = "done" | "retry";

/**
 * Handles one message exactly once. The `wamid` marker is stored first (atomic insert, so duplicates and
 * concurrent deliveries stop here). If handling or sending then fails:
 *   - nothing had been changed: the marker is removed and the delivery is answered 5xx, so Meta's retry
 *     reprocesses the message;
 *   - the agenda had already been changed (a booking or cancellation): the marker stays, so a retry can
 *     never apply it twice; the confirmation is lost, but "Mis citas" shows the result.
 */
async function processMessage(
  deps: Required<Pick<WhatsAppWebhookDeps, "client" | "store">> & { logger: WhatsAppLogger; now: () => Date },
  channel: { phoneNumberId: string; businessId: string; businessName: string; timezone: string },
  message: IncomingMessage,
): Promise<Outcome> {
  const { store, client, logger } = deps;
  const claimed = await store.claimMessage({ wamid: message.wamid, businessId: channel.businessId });
  if (!claimed) {
    logger.info("duplicate message ignored", { wamid: message.wamid });
    return "done";
  }

  const effects: EffectTracker = { applied: false };
  try {
    const reply = await handleIncoming(
      {
        store,
        businessId: channel.businessId,
        businessName: channel.businessName,
        timezone: channel.timezone,
        phone: message.from,
        now: deps.now(),
        effects,
      },
      message.content,
    );
    await client.sendMessage({ phoneNumberId: channel.phoneNumberId, message: reply });
    logger.info("message handled", { wamid: message.wamid, from: maskPhone(message.from) });
    return "done";
  } catch (error) {
    const fields = { wamid: message.wamid, from: maskPhone(message.from), reason: describeError(error) };
    if (effects.applied) {
      logger.error("reply failed after a side effect; the message stays marked so it is not applied twice", fields);
      return "done";
    }

    logger.error("message failed before any side effect; asking Meta to retry", fields);
    await store.releaseMessage(message.wamid).catch((releaseError: unknown) => {
      logger.error("could not remove the message marker", { wamid: message.wamid, reason: describeError(releaseError) });
    });
    return "retry";
  }
}

async function processBatch(
  deps: Parameters<typeof processMessage>[0],
  batch: IncomingBatch,
  logger: WhatsAppLogger,
): Promise<Outcome> {
  const channel = await deps.store.findChannel(batch.phoneNumberId);
  if (!channel) {
    logger.warn("message for an unregistered phone_number_id ignored", { phoneNumberId: batch.phoneNumberId });
    return "done";
  }

  let outcome: Outcome = "done";
  for (const message of batch.messages) {
    const result = await processMessage(deps, { ...channel, phoneNumberId: batch.phoneNumberId }, message);
    if (result === "retry") outcome = "retry";
  }
  return outcome;
}

/**
 * `GET/POST /api/whatsapp/webhook`. Meta calls these without a session, so they are authenticated by the
 * verify token (handshake) and by the HMAC signature of the raw body (deliveries) instead.
 */
export function createWhatsAppRoutes(deps: WhatsAppWebhookDeps) {
  const logger = deps.logger ?? consoleLogger;
  const now = deps.now ?? (() => new Date());
  const handlerDeps = { client: deps.client, store: deps.store, logger, now };
  const routes = new Hono();

  // Anyone can POST unsigned bodies, so the rejection warning is rate-limited: one line per interval that
  // says how many were held back since the previous one.
  let lastRejectionLog = Number.NEGATIVE_INFINITY;
  let suppressedRejections = 0;
  const logRejection = () => {
    const at = now().getTime();
    if (at - lastRejectionLog < REJECTION_LOG_INTERVAL_MS) {
      suppressedRejections += 1;
      return;
    }
    logger.warn("webhook delivery rejected: invalid or missing signature", { suppressed: suppressedRejections });
    lastRejectionLog = at;
    suppressedRejections = 0;
  };

  routes.get("/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");

    // The token is compared in constant time; every failure gets the same bare 403.
    // An empty configured token never matches: a misconfigured instance must not verify anyone.
    const tokenOk = deps.verifyToken !== "" && token !== undefined && safeEqual(token, deps.verifyToken);
    if (mode !== "subscribe" || !tokenOk || challenge === undefined) return c.json(forbidden, 403);

    return c.text(challenge, 200, { "x-content-type-options": "nosniff" });
  });

  routes.post(
    "/webhook",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(tooLarge, 413) }),
    async (c) => {
      // The signature covers the exact bytes Meta sent: read them once, verify, and only then parse.
      const raw = new Uint8Array(await c.req.arrayBuffer());
      if (!verifySignature(deps.appSecret, raw, c.req.header("x-hub-signature-256"))) {
        logRejection();
        return c.json(invalidSignature, 401);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return c.json(invalidRequest, 400);
      }

      let outcome: Outcome = "done";
      try {
        for (const batch of extractIncomingBatches(payload)) {
          if ((await processBatch(handlerDeps, batch, logger)) === "retry") outcome = "retry";
        }
      } catch (error) {
        // The database failed while routing or marking a message: nothing was applied for it, so Meta may retry.
        logger.error("webhook delivery could not be processed", { reason: describeError(error) });
        outcome = "retry";
      }

      // 200 for everything handled or deliberately ignored; 503 only so Meta redelivers what could not be handled.
      return outcome === "retry" ? c.json(unavailable, 503) : c.json({ status: "ok" }, 200);
    },
  );

  return routes;
}
