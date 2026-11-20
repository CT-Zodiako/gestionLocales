import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bodyOf,
  createHarness,
  descriptionsOf,
  pick,
  replyIdsOf,
  titlesOf,
  type Harness,
} from "./support/whatsapp-harness.ts";
import { createApiTenant, type ApiTenant } from "./support/reminders.ts";

const newPhone = () => `57300${randomInt(1_000_000, 9_999_999)}`;
const SLOT = "2031-03-11T14:00:00.000Z"; // Tuesday 09:00 in Bogotá; the harness clock is Monday 08:00

describe("prices in the WhatsApp bot", () => {
  let harness: Harness;
  let owner: ApiTenant;

  beforeAll(async () => {
    harness = await createHarness();
    owner = await createApiTenant(harness, { services: [{ name: "Corte", durationMinutes: 30, price: 25000 }] });
  });

  afterAll(async () => {
    await owner.dispose();
    await harness.close();
  });

  describe("service list", () => {
    it("shows the duration and the es-CO price in the row description, and only the duration when there is no price", async () => {
      const tenant = await harness.newTenant({
        services: [
          { name: "Corte", durationMinutes: 30, price: 25000 },
          { name: "Sin precio", durationMinutes: 45 },
          { name: "Gratis", durationMinutes: 15, price: 0 },
          { name: "Mil", durationMinutes: 20, price: 999 },
          { name: "Tinte", durationMinutes: 90, price: 1234567 },
          { name: "Tope", durationMinutes: 1440, price: 100_000_000 },
        ],
      });
      const customer = await tenant.namedCustomer(newPhone(), "Ana");

      const services = await customer.tap("menu:book");

      expect(titlesOf(services)).toEqual(["Corte", "Sin precio", "Gratis", "Mil", "Tinte", "Tope"]);
      expect(descriptionsOf(services)).toEqual([
        "30 min · $25.000",
        "45 min",
        "15 min · $0",
        "20 min · $999",
        "90 min · $1.234.567",
        "1440 min · $100.000.000",
      ]);
    });

    it("never lists an inactive service, with or without a price", async () => {
      const tenant = await harness.newTenant({
        services: [
          { name: "Activo", durationMinutes: 30, price: 20000 },
          { name: "Viejo caro", durationMinutes: 30, price: 90000, active: false },
          { name: "Viejo", durationMinutes: 30, active: false },
        ],
      });
      const customer = await tenant.namedCustomer(newPhone(), "Ana");

      const services = await customer.tap("menu:book");

      expect(titlesOf(services)).toEqual(["Activo"]);
      expect(replyIdsOf(services)).toEqual([`svc:${tenant.serviceIds[0]}`]);
      expect(JSON.stringify(services)).not.toMatch(/90\.000|Viejo/);
    });

    it("keeps the three-button main menu, without a price button", async () => {
      const tenant = await harness.newTenant({ services: [{ name: "Corte", durationMinutes: 30, price: 25000 }] });

      const menu = await tenant.customer(newPhone()).say("precios");

      expect(titlesOf(menu)).toEqual(["Agendar", "Mis citas", "Cancelar"]);
    });

    it("follows price changes made through the API: set, change, clear and deactivate", async () => {
      const serviceId = owner.tenant.serviceIds[0] ?? "";
      const customer = await owner.tenant.namedCustomer(newPhone(), "Ana");
      const shown = async () => descriptionsOf(await customer.tap("menu:book"));

      expect(await shown()).toEqual(["30 min · $25.000"]);

      expect((await owner.call("PATCH", `/services/${serviceId}`, { price: 30000 })).status).toBe(200);
      expect(await shown()).toEqual(["30 min · $30.000"]);

      expect((await owner.call("PATCH", `/services/${serviceId}`, { price: null })).status).toBe(200);
      expect(await shown()).toEqual(["30 min"]);

      expect((await owner.call("PATCH", `/services/${serviceId}`, { price: 25000, active: false })).status).toBe(200);
      const none = await customer.tap("menu:book");
      expect(bodyOf(none)).toMatch(/no hay servicios/i);
      expect(JSON.stringify(none)).not.toContain("25.000");

      expect((await owner.call("PATCH", `/services/${serviceId}`, { active: true })).status).toBe(200);
      expect(await shown()).toEqual(["30 min · $25.000"]);
    });
  });

  describe("booking confirmation and Mis citas", () => {
    it("shows the price in the confirmation question, the confirmed booking, the repeated booking and Mis citas", async () => {
      const tenant = await harness.newTenant({ services: [{ name: "Corte", durationMinutes: 30, price: 25000 }] });
      const serviceId = tenant.serviceIds[0] ?? "";
      const customer = await tenant.namedCustomer(newPhone(), "Ana");

      const question = await customer.tap(`slot:${serviceId}:${SLOT}`);
      const done = await customer.tap(`ok:${serviceId}:${SLOT}`, "button_reply");
      const again = await customer.tap(`ok:${serviceId}:${SLOT}`, "button_reply");
      const mine = await customer.tap("menu:mine");

      expect(bodyOf(question)).toContain("Corte (30 min · $25.000)");
      expect(bodyOf(done)).toMatch(/confirmada/i);
      expect(bodyOf(done)).toContain("Corte (30 min · $25.000)");
      expect(bodyOf(again)).toMatch(/ya tienes esa cita/i);
      expect(bodyOf(again)).toContain("Corte (30 min · $25.000)");
      expect(bodyOf(mine)).toContain("• mar 11 mar, 09:00 — Corte · $25.000");
    });

    it("leaves the texts as they were when the service has no price", async () => {
      const tenant = await harness.newTenant({ services: [{ name: "Corte", durationMinutes: 30 }] });
      const serviceId = tenant.serviceIds[0] ?? "";
      const customer = await tenant.namedCustomer(newPhone(), "Ana");

      const question = await customer.tap(`slot:${serviceId}:${SLOT}`);
      const done = await customer.tap(`ok:${serviceId}:${SLOT}`, "button_reply");
      const mine = await customer.tap("menu:mine");

      expect(bodyOf(question)).toContain("Corte (30 min)\n");
      expect(bodyOf(done)).toContain("Corte (30 min)\n");
      expect(bodyOf(mine)).toMatch(/• mar 11 mar, 09:00 — Corte\n|• mar 11 mar, 09:00 — Corte$/m);
      for (const message of [question, done, mine]) expect(bodyOf(message)).not.toContain("$");
    });

    it("lists a price per appointment in Mis citas, free ones without it", async () => {
      const tenant = await harness.newTenant({
        services: [
          { name: "Corte", durationMinutes: 30, price: 25000 },
          { name: "Barba", durationMinutes: 30 },
        ],
      });
      const [corte = "", barba = ""] = tenant.serviceIds;
      const phone = newPhone();
      const customer = await tenant.namedCustomer(phone, "Ana");
      await tenant.bookDirect(corte, phone, new Date(SLOT), 30);
      await tenant.bookDirect(barba, phone, new Date("2031-03-11T15:00:00.000Z"), 30);

      const mine = await customer.tap("menu:mine");

      const lines = bodyOf(mine).split("\n").filter((line) => line.startsWith("•"));
      expect(lines).toEqual(["• mar 11 mar, 09:00 — Corte · $25.000", "• mar 11 mar, 10:00 — Barba"]);
    });
  });

  describe("WhatsApp length limits", () => {
    it("keeps every message within limits for long service names with the largest price and duration", async () => {
      // The fake client rejects any message over a WhatsApp limit, so each tap below doubles as a limit check.
      const long = "Tratamiento capilar completo con keratina, corte y peinado de fiesta";
      const tenant = await harness.newTenant({
        services: [
          { name: long, durationMinutes: 1440, price: 100_000_000 },
          { name: `${"é".repeat(60)}😀😀😀`, durationMinutes: 45, price: 1234567 },
        ],
        hours: [{ weekday: 2, opensAt: "00:00", closesAt: "23:59" }],
      });
      const [, second = ""] = tenant.serviceIds;
      const customer = await tenant.namedCustomer(newPhone(), "Ana");

      const services = await customer.tap("menu:book");
      const days = await customer.tap(`svc:${second}`);
      const slots = await customer.tap(pick(days, "day:"));
      const question = await customer.tap(pick(slots, "slot:"));
      const done = await customer.tap(pick(question, "ok:"), "button_reply");
      const mine = await customer.tap("menu:mine");

      expect(titlesOf(services).every((title) => title.length <= 24)).toBe(true);
      expect(descriptionsOf(services).every((text) => (text ?? "").length <= 72)).toBe(true);
      expect(descriptionsOf(services)).toEqual(["1440 min · $100.000.000", "45 min · $1.234.567"]);
      expect(bodyOf(question)).toContain("$1.234.567");
      expect(bodyOf(done).length).toBeLessThanOrEqual(1024);
      expect(bodyOf(mine)).toContain("$1.234.567");
      expect(bodyOf(mine).length).toBeLessThanOrEqual(1024);
    });
  });
});
