import { describe, expect, it } from "vitest";
import { createFetchWhatsAppClient, isAuthSendError, isPermanentSendError, WhatsAppSendError } from "../src/whatsapp/client.ts";
import { templateMessage } from "../src/whatsapp/messages.ts";
import { ACCESS_TOKEN } from "./support/whatsapp.ts";

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  };
  return { calls, fetchImpl };
}

const input = { to: "573001234567", name: "cita_confirmacion", language: "es", bodyParameters: ["Ana", "Corte", "13/03/2031", "09:00"] };

describe("templateMessage", () => {
  it("builds the Graph API template payload with one body component of text parameters, in order", () => {
    expect(templateMessage(input)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573001234567",
      type: "template",
      template: {
        name: "cita_confirmacion",
        language: { code: "es" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ana" },
              { type: "text", text: "Corte" },
              { type: "text", text: "13/03/2031" },
              { type: "text", text: "09:00" },
            ],
          },
        ],
      },
    });
  });
});

describe("createFetchWhatsAppClient.sendTemplate", () => {
  it("POSTs the template to /messages with the Bearer token and returns the WhatsApp message id", async () => {
    // Given
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.HBgM123" }] }));
    const client = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: fetchImpl });
    const message = templateMessage(input);

    // When
    const result = await client.sendTemplate({ phoneNumberId: "109876543210", message });

    // Then
    expect(result).toEqual({ messageId: "wamid.HBgM123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v23.0/109876543210/messages");
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(message);
  });

  it("accepts an answer without a message id (the send itself succeeded)", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({}));
    const client = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: fetchImpl });

    expect(await client.sendTemplate({ phoneNumberId: "42", message: templateMessage(input) })).toEqual({ messageId: null });
  });

  it("rejects with a WhatsAppSendError carrying only the status and Graph code, never the token or the recipient", async () => {
    const body = { error: { message: `Invalid token ${ACCESS_TOKEN} for 573001234567`, code: 132001 } };
    const { fetchImpl } = fakeFetch(() => Response.json(body, { status: 404 }));
    const client = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: fetchImpl });

    const failure = await client.sendTemplate({ phoneNumberId: "42", message: templateMessage(input) }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WhatsAppSendError);
    expect((failure as WhatsAppSendError).status).toBe(404);
    expect(isPermanentSendError(failure)).toBe(true);
    expect(String((failure as Error).message)).not.toContain(ACCESS_TOKEN);
    expect(String((failure as Error).message)).not.toContain("573001234567");
  });

  it.each([500, 502, 503, 408, 429])("classifies a %i as transient, like the webhook does", async (status) => {
    const { fetchImpl } = fakeFetch(() => Response.json({}, { status }));
    const client = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: fetchImpl });

    const failure = await client.sendTemplate({ phoneNumberId: "42", message: templateMessage(input) }).catch((error: unknown) => error);

    expect(isPermanentSendError(failure)).toBe(false);
  });

  it("refuses a phone number id that is not digits, without calling the network", async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({}));
    const client = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: fetchImpl });

    await expect(client.sendTemplate({ phoneNumberId: "../evil", message: templateMessage(input) })).rejects.toThrow("Invalid phone number id");
    expect(calls).toEqual([]);
  });
});

describe("isAuthSendError", () => {
  it.each([
    [new WhatsAppSendError(401), true],
    [new WhatsAppSendError(403), true],
    [new WhatsAppSendError(400, 190), true],
    [new WhatsAppSendError(401, 190), true],
    [new WhatsAppSendError(400), false],
    [new WhatsAppSendError(400, 132001), false],
    [new WhatsAppSendError(404), false],
    [new WhatsAppSendError(429), false],
    [new WhatsAppSendError(500), false],
    [new Error("401"), false],
    [new TypeError("fetch failed"), false],
    ["401", false],
  ])("classifies %o as auth=%s", (error, expected) => {
    expect(isAuthSendError(error)).toBe(expected);
  });

  it("keeps 401 and 403 permanent for the webhook's own classification", () => {
    expect(isPermanentSendError(new WhatsAppSendError(401))).toBe(true);
    expect(isPermanentSendError(new WhatsAppSendError(403))).toBe(true);
  });

  it("recognises a Graph code 190 answer from the real client, keeping the code on the error and the token out of its message", async () => {
    const body = { error: { message: `Error validating access token ${ACCESS_TOKEN}`, type: "OAuthException", code: 190 } };
    const { fetchImpl } = fakeFetch(() => Response.json(body, { status: 400 }));
    const client = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: fetchImpl });

    const failure = await client.sendTemplate({ phoneNumberId: "42", message: templateMessage(input) }).catch((error: unknown) => error);

    expect(isAuthSendError(failure)).toBe(true);
    expect((failure as WhatsAppSendError).graphCode).toBe(190);
    expect((failure as Error).message).not.toContain(ACCESS_TOKEN);
  });
});
