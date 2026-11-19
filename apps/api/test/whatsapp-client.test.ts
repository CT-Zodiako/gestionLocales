import { describe, expect, it } from "vitest";
import { createFetchWhatsAppClient, DEFAULT_GRAPH_BASE_URL, isPermanentSendError, WhatsAppSendError } from "../src/whatsapp/client.ts";
import { textMessage } from "../src/whatsapp/messages.ts";
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

describe("createFetchWhatsAppClient", () => {
  it("POSTs the message to the Graph API with a Bearer token and the configured version", async () => {
    // Given
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ messages: [{ id: "wamid.x" }] }));
    const client = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: fetchImpl });
    const message = textMessage("573001234567", "Hola");

    // When
    await client.sendMessage({ phoneNumberId: "109876543210", message });

    // Then
    expect(DEFAULT_GRAPH_BASE_URL).toBe("https://graph.facebook.com");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v23.0/109876543210/messages");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(message);
  });

  it("honours a base URL override and another API version", async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({}));
    const client = createFetchWhatsAppClient({
      token: ACCESS_TOKEN,
      apiVersion: "v99.1",
      baseUrl: "http://stub.local:9999",
      fetch: fetchImpl,
    });

    await client.sendMessage({ phoneNumberId: "42", message: textMessage("573001234567", "Hola") });

    expect(calls[0]?.url).toBe("http://stub.local:9999/v99.1/42/messages");
  });

  it("rejects with a WhatsAppSendError carrying the status and Graph error code, never the token or the recipient", async () => {
    const body = { error: { message: `Invalid token ${ACCESS_TOKEN} for 573001234567`, type: "OAuthException", code: 190 } };
    const { fetchImpl } = fakeFetch(() => Response.json(body, { status: 401 }));
    const client = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: fetchImpl });

    const failure = await client
      .sendMessage({ phoneNumberId: "42", message: textMessage("573001234567", "Hola") })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WhatsAppSendError);
    expect((failure as WhatsAppSendError).status).toBe(401);
    expect((failure as WhatsAppSendError).message).toBe("WhatsApp send failed with status 401 (Graph error code 190)");
    expect(String((failure as Error).message)).not.toContain(ACCESS_TOKEN);
    expect(String((failure as Error).message)).not.toContain("573001234567");
  });

  it("rejects when the network fails or the response is not JSON", async () => {
    const failing = createFetchWhatsAppClient({
      token: ACCESS_TOKEN,
      apiVersion: "v23.0",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const html = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const gateway = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: html.fetchImpl });
    const input = { phoneNumberId: "42", message: textMessage("573001234567", "Hola") };

    await expect(failing.sendMessage(input)).rejects.toThrow();
    await expect(gateway.sendMessage(input)).rejects.toThrow("WhatsApp send failed with status 502");
  });

  it("refuses a phone number id that is not digits, so the path cannot be altered", async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({}));
    const client = createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: fetchImpl });

    await expect(
      client.sendMessage({ phoneNumberId: "../../other", message: textMessage("573001234567", "Hola") }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("isPermanentSendError", () => {
  it.each([400, 401, 403, 404, 410, 422, 499])("treats HTTP %i as permanent", (status) => {
    expect(isPermanentSendError(new WhatsAppSendError(status))).toBe(true);
  });

  it.each([408, 429, 500, 502, 503, 504])("treats HTTP %i as transient", (status) => {
    expect(isPermanentSendError(new WhatsAppSendError(status))).toBe(false);
  });

  it.each<[string, unknown]>([
    ["a network error", new TypeError("fetch failed")],
    ["a timeout", new DOMException("timed out", "TimeoutError")],
    ["a plain error", new Error("boom")],
    ["a non-error", "boom"],
    ["undefined", undefined],
  ])("treats %s as transient", (_name, error) => {
    expect(isPermanentSendError(error)).toBe(false);
  });

  it("classifies what the real client throws: a 401 response is permanent, a 500 response and a network failure are not", async () => {
    const respond = (status: number) =>
      createFetchWhatsAppClient({ token: ACCESS_TOKEN, apiVersion: "v23.0", fetch: async () => Response.json({ error: { code: 190 } }, { status }) });
    const network = createFetchWhatsAppClient({
      token: ACCESS_TOKEN,
      apiVersion: "v23.0",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const input = { phoneNumberId: "42", message: textMessage("573001234567", "Hola") };
    const failure = (client: ReturnType<typeof createFetchWhatsAppClient>) => client.sendMessage(input).catch((error: unknown) => error);

    expect(isPermanentSendError(await failure(respond(401)))).toBe(true);
    expect(isPermanentSendError(await failure(respond(500)))).toBe(false);
    expect(isPermanentSendError(await failure(network))).toBe(false);
  });
});
