import { describe, expect, it } from "vitest";
import { buttonsMessage, listMessage, textMessage, truncate, WHATSAPP_LIMITS } from "../src/whatsapp/messages.ts";
import { assertWithinLimits, LIMITS } from "./support/whatsapp.ts";

const TO = "573001234567";

describe("truncate", () => {
  it("leaves short text alone and cuts long text to the limit with an ellipsis", () => {
    expect(truncate("Corte", 24)).toBe("Corte");
    expect(truncate("a".repeat(24), 24)).toBe("a".repeat(24));
    expect(truncate("a".repeat(25), 24)).toBe(`${"a".repeat(23)}…`);
    expect(truncate("Corte de cabello y barba con tratamiento", 20)).toBe("Corte de cabello y…");
  });

  it("collapses whitespace and line breaks into single spaces", () => {
    expect(truncate("  Corte\n\n  de   pelo\t", 24)).toBe("Corte de pelo");
  });

  it("never splits a surrogate pair", () => {
    const text = `${"a".repeat(22)}😀😀😀`;
    const cut = truncate(text, 24);
    expect(cut.length).toBeLessThanOrEqual(24);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/[\ud800-\udbff]…$/);
    expect(cut).toBe(`${"a".repeat(22)}…`);
  });
});

describe("message builders", () => {
  it("exposes the WhatsApp limits it enforces", () => {
    expect(WHATSAPP_LIMITS).toMatchObject({
      buttonTitle: LIMITS.buttonTitle,
      rowTitle: LIMITS.rowTitle,
      rowDescription: LIMITS.rowDescription,
      maxButtons: LIMITS.maxButtons,
      maxRows: LIMITS.maxRows,
      interactiveBody: LIMITS.interactiveBody,
      header: LIMITS.header,
      footer: LIMITS.footer,
    });
  });

  it("builds a text message", () => {
    const message = textMessage(TO, "Hola");
    expect(message).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: TO,
      type: "text",
      text: { body: "Hola", preview_url: false },
    });
  });

  it("builds reply buttons and truncates every field to its limit", () => {
    const message = buttonsMessage({
      to: TO,
      body: "b".repeat(2000),
      footer: "f".repeat(200),
      buttons: [
        { id: "menu:book", title: "Agendar una cita ahora mismo" },
        { id: "menu:mine", title: "Mis citas" },
      ],
    });

    assertWithinLimits(message);
    if (message.type !== "interactive" || message.interactive.type !== "button") throw new Error("not a button message");
    expect(message.interactive.action.buttons.map((button) => button.reply.title)).toEqual(["Agendar una cita ah…", "Mis citas"]);
    expect(message.interactive.body.text.endsWith("…")).toBe(true);
  });

  it("builds a list, truncating titles and descriptions and keeping ids intact", () => {
    const message = listMessage({
      to: TO,
      header: "h".repeat(100),
      body: "Elige un servicio",
      footer: "Gracias",
      buttonLabel: "Ver los servicios disponibles",
      sectionTitle: "Servicios de la peluquería",
      rows: [
        { id: "svc:1", title: "Corte de cabello con lavado y secado", description: "d".repeat(200) },
        { id: "svc:2", title: "Barba" },
      ],
    });

    assertWithinLimits(message);
    if (message.type !== "interactive" || message.interactive.type !== "list") throw new Error("not a list message");
    const [first, second] = message.interactive.action.sections.flatMap((section) => section.rows);
    expect(first?.id).toBe("svc:1");
    expect(first?.title).toBe("Corte de cabello con la…");
    expect(first?.description).toHaveLength(72);
    expect(second).toEqual({ id: "svc:2", title: "Barba" });
  });

  it("refuses to build more than 3 buttons, more than 10 rows, empty rows or ids over the limit", () => {
    const button = (n: number) => ({ id: `b:${n}`, title: `B${n}` });
    const row = (n: number) => ({ id: `r:${n}`, title: `R${n}` });

    expect(() => buttonsMessage({ to: TO, body: "x", buttons: [1, 2, 3, 4].map(button) })).toThrow(RangeError);
    expect(() => buttonsMessage({ to: TO, body: "x", buttons: [] })).toThrow(RangeError);
    expect(() => buttonsMessage({ to: TO, body: "x", buttons: [{ id: "i".repeat(300), title: "ok" }] })).toThrow(RangeError);
    expect(() =>
      listMessage({ to: TO, body: "x", buttonLabel: "Ver", rows: Array.from({ length: 11 }, (_, n) => row(n)) }),
    ).toThrow(RangeError);
    expect(() => listMessage({ to: TO, body: "x", buttonLabel: "Ver", rows: [] })).toThrow(RangeError);
    expect(() => listMessage({ to: TO, body: "x", buttonLabel: "Ver", rows: [{ id: "i".repeat(201), title: "ok" }] })).toThrow(RangeError);
    expect(() => listMessage({ to: TO, body: "x", buttonLabel: "Ver", rows: [row(1), row(1)] })).toThrow(RangeError);
    expect(listMessage({ to: TO, body: "x", buttonLabel: "Ver", rows: Array.from({ length: 10 }, (_, n) => row(n)) })).toBeTruthy();
  });
});
