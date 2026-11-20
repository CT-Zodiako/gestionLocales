import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newWamid, replyPayload } from "./support/whatsapp.ts";
import type { OutgoingMessage } from "../src/whatsapp/messages.ts";
import {
  MENU_IDS,
  MINUTE,
  bodyOf,
  createHarness,
  pick,
  replyIdsOf,
  titlesOf,
  type Customer,
  type Harness,
  type Tenant,
} from "./support/whatsapp-harness.ts";

function newPhone(): string {
  return `57300${randomInt(1_000_000, 9_999_999)}`;
}

/** The reply is the main menu: reply buttons Agendar / Mis citas / Cancelar. */
function expectMenu(message: OutgoingMessage): void {
  expect(message.type).toBe("interactive");
  expect(replyIdsOf(message)).toEqual(MENU_IDS);
}

/** The reply is a politely worded refusal that ends in the main menu, with no technical noise. */
function expectRefusal(message: OutgoingMessage): void {
  expectMenu(message);
  expect(bodyOf(message)).toMatch(/no es válida|ya no está disponible|no encontr/i);
  expect(bodyOf(message)).not.toMatch(/error|exception|undefined|null|\bat\s.*\(|stack|sql|postgres/i);
}

describe("WhatsApp menu bot", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe("main menu", () => {
    it("answers any text with the three-button menu, whatever it says", async () => {
      const tenant = await harness.newTenant();
      const customer = tenant.customer(newPhone());

      for (const text of ["hola", "¿cuánto cuesta un corte?", "1", "AGENDAR", "", "   ", "😀", "x".repeat(3000)]) {
        expectMenu(await customer.say(text));
      }
    });

    it("greets by business name and offers exactly Agendar, Mis citas and Cancelar", async () => {
      const tenant = await harness.newTenant();

      const menu = await tenant.customer(newPhone()).say("hola");

      expect(titlesOf(menu)).toEqual(["Agendar", "Mis citas", "Cancelar"]);
      expect(bodyOf(menu)).toMatch(/hola/i);
    });

    it("shows the menu again for ids it does not know, from a stale or foreign conversation", async () => {
      const tenant = await harness.newTenant();

      expectRefusal(await tenant.customer(newPhone()).tap("menu:unknown"));
    });
  });

  describe("booking flow", () => {
    it("books through services, days and slots in the business timezone (America/Bogota)", async () => {
      // Given - a Monday 08:00 in Bogotá, a service of 30 minutes, open Monday to Friday 09:00-11:00
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const phone = newPhone();
      const customer = await tenant.namedCustomer(phone, "Ana"); // a customer already named: the name step has its own tests

      // When - Agendar
      const services = await customer.tap("menu:book", "button_reply");
      const days = await customer.tap(`svc:${serviceId}`);
      const slots = await customer.tap(`day:${serviceId}:2031-03-11`);
      const confirmation = await customer.tap("slot:" + serviceId + ":2031-03-11T14:00:00.000Z");
      const done = await customer.tap(`ok:${serviceId}:2031-03-11T14:00:00.000Z`, "button_reply");

      // Then
      expect(replyIdsOf(services)).toEqual([`svc:${serviceId}`]);
      expect(titlesOf(services)).toEqual(["Corte"]);
      expect(replyIdsOf(days)).toEqual(["10", "11", "12", "13", "14"].map((day) => `day:${serviceId}:2031-03-${day}`));
      expect(titlesOf(days)).toEqual(["lun 10 mar", "mar 11 mar", "mié 12 mar", "jue 13 mar", "vie 14 mar"]);
      expect(replyIdsOf(slots)).toEqual(
        ["14:00", "14:30", "15:00", "15:30"].map((time) => `slot:${serviceId}:2031-03-11T${time}:00.000Z`),
      );
      expect(titlesOf(slots)).toEqual(["09:00", "09:30", "10:00", "10:30"]);
      expect(replyIdsOf(confirmation)[0]).toBe(`ok:${serviceId}:2031-03-11T14:00:00.000Z`);
      expect(bodyOf(confirmation)).toContain("Corte");
      expect(bodyOf(confirmation)).toContain("09:00");
      expectMenu(done);
      expect(bodyOf(done)).toMatch(/confirmada/i);
      expect(bodyOf(done)).toContain("09:00");

      const stored = await tenant.appointments();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        customerPhone: phone,
        serviceId,
        status: "booked",
        serviceName: "Corte",
      });
      expect(stored[0]?.startsAt.toISOString()).toBe("2031-03-11T14:00:00.000Z");
      expect(stored[0]?.endsAt.toISOString()).toBe("2031-03-11T14:30:00.000Z");
    });

    it("uses the sender number, not anything in the message, to identify the customer", async () => {
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const [first, second] = [newPhone(), newPhone()];

      await tenant.customer(first).tap(`ok:${serviceId}:2031-03-11T14:00:00.000Z`);
      await tenant.customer(second).tap(`ok:${serviceId}:2031-03-11T14:30:00.000Z`);

      const stored = await tenant.appointments();
      expect(stored.map((row) => row.customerPhone)).toEqual([first, second]);
      expect(new Set(stored.map((row) => row.customerId)).size).toBe(2);
    });

    it("reuses the customer row of a phone that books twice", async () => {
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const customer = tenant.customer(newPhone());

      await customer.tap(`ok:${serviceId}:2031-03-11T14:00:00.000Z`);
      await customer.tap(`ok:${serviceId}:2031-03-12T14:00:00.000Z`);

      const stored = await tenant.appointments();
      expect(stored).toHaveLength(2);
      expect(stored[0]?.customerId).toBe(stored[1]?.customerId);
    });

    it("books in a DST zone: wall-clock times on both sides of the spring change (America/New_York)", async () => {
      // Given - Saturday 10:00 EST; the clocks change on Sunday 2031-03-09 at 02:00
      harness.clock.now = new Date("2031-03-08T15:00:00.000Z");
      try {
        const tenant = await harness.newTenant({
          timezone: "America/New_York",
          hours: [
            { weekday: 0, opensAt: "00:00", closesAt: "06:00" },
            { weekday: 1, opensAt: "09:00", closesAt: "10:00" },
          ],
          services: [{ name: "Consulta", durationMinutes: 60 }],
        });
        const serviceId = tenant.serviceIds[0] ?? "";
        const customer = tenant.customer(newPhone());

        // When
        const days = await customer.tap(`svc:${serviceId}`);
        const sunday = await customer.tap(`day:${serviceId}:2031-03-09`);
        const monday = await customer.tap(`day:${serviceId}:2031-03-10`);
        await customer.tap(`ok:${serviceId}:2031-03-09T07:00:00.000Z`);
        await customer.tap(`ok:${serviceId}:2031-03-10T13:00:00.000Z`);

        // Then - there is no 02:00 on the day of the change and the offset differs between Sunday and Monday
        expect(titlesOf(days)).toEqual(["dom 9 mar", "lun 10 mar"]);
        expect(titlesOf(sunday)).toEqual(["00:00", "01:00", "03:00", "04:00", "05:00"]);
        expect(replyIdsOf(sunday)[2]).toBe(`slot:${serviceId}:2031-03-09T07:00:00.000Z`);
        expect(replyIdsOf(monday)).toEqual([`slot:${serviceId}:2031-03-10T13:00:00.000Z`]);
        expect(titlesOf(monday)).toEqual(["09:00"]);
        const [sundayBooking, mondayBooking] = await tenant.appointments();
        expect(sundayBooking?.startsAt.toISOString()).toBe("2031-03-09T07:00:00.000Z"); // 03:00 EDT
        expect(sundayBooking?.endsAt.toISOString()).toBe("2031-03-09T08:00:00.000Z");
        expect(mondayBooking?.startsAt.toISOString()).toBe("2031-03-10T13:00:00.000Z"); // 09:00 EDT
      } finally {
        harness.clock.now = new Date("2031-03-10T13:00:00.000Z");
      }
    });

    it("never offers a past slot today: only the slots still ahead of now are listed", async () => {
      harness.clock.now = new Date("2031-03-10T14:45:00.000Z"); // 09:45 in Bogotá
      try {
        const tenant = await harness.newTenant();
        const serviceId = tenant.serviceIds[0] ?? "";

        const slots = await tenant.customer(newPhone()).tap(`day:${serviceId}:2031-03-10`);

        expect(titlesOf(slots)).toEqual(["10:00", "10:30"]);
      } finally {
        harness.clock.now = new Date("2031-03-10T13:00:00.000Z");
      }
    });

    it("lists the next 7 days that have opening hours, skipping days that are closed", async () => {
      const tenant = await harness.newTenant({ hours: [{ weekday: 3, opensAt: "09:00", closesAt: "10:00" }, { weekday: 0, opensAt: "09:00", closesAt: "10:00" }] });
      const serviceId = tenant.serviceIds[0] ?? "";

      const days = await tenant.customer(newPhone()).tap(`svc:${serviceId}`);

      expect(replyIdsOf(days)).toEqual([`day:${serviceId}:2031-03-12`, `day:${serviceId}:2031-03-16`]);
    });

    it("pages through more than 10 slots with Más horarios and reaches every slot exactly once", async () => {
      // Given - 08:00-18:00 with 30-minute slots: 20 slots on Tuesday
      const tenant = await harness.newTenant({ hours: [{ weekday: 2, opensAt: "08:00", closesAt: "18:00" }] });
      const serviceId = tenant.serviceIds[0] ?? "";
      const customer = tenant.customer(newPhone());

      // When
      const pages: OutgoingMessage[] = [await customer.tap(`day:${serviceId}:2031-03-11`)];
      for (let guard = 0; guard < 5; guard++) {
        const last = pages.at(-1);
        const more = last ? replyIdsOf(last).find((id) => id.startsWith("more:")) : undefined;
        if (!more) break;
        pages.push(await customer.tap(more));
      }

      // Then
      const slotIds = pages.flatMap((page) => replyIdsOf(page).filter((id) => id.startsWith("slot:")));
      expect(pages).toHaveLength(3);
      expect(pages.map((page) => replyIdsOf(page).length)).toEqual([10, 10, 2]);
      expect(pages.map((page) => replyIdsOf(page).filter((id) => id.startsWith("more:")).length)).toEqual([1, 1, 0]);
      expect(titlesOf(pages[0]!).at(-1)).toBe("Más horarios");
      expect(slotIds).toHaveLength(20);
      expect(new Set(slotIds).size).toBe(20);
      expect(titlesOf(pages[0]!)[0]).toBe("08:00");
      expect(titlesOf(pages[2]!)).toEqual(["17:00", "17:30"]);
    });

    it("shows a single page of exactly 10 slots without Más horarios", async () => {
      const tenant = await harness.newTenant({ hours: [{ weekday: 2, opensAt: "08:00", closesAt: "13:00" }] });
      const serviceId = tenant.serviceIds[0] ?? "";

      const page = await tenant.customer(newPhone()).tap(`day:${serviceId}:2031-03-11`);

      expect(replyIdsOf(page)).toHaveLength(10);
      expect(replyIdsOf(page).some((id) => id.startsWith("more:"))).toBe(false);
    });

    it("falls back to the first page for a stale or out-of-range Más horarios offset", async () => {
      const tenant = await harness.newTenant({ hours: [{ weekday: 2, opensAt: "08:00", closesAt: "18:00" }] });
      const serviceId = tenant.serviceIds[0] ?? "";
      const customer = tenant.customer(newPhone());

      for (const offset of ["500", "-3", "abc", "1.5", "99999999999999999999"]) {
        const page = await customer.tap(`more:${serviceId}:2031-03-11:${offset}`);
        if (offset === "500") {
          expect(replyIdsOf(page)[0]).toBe(`slot:${serviceId}:2031-03-11T13:00:00.000Z`);
        } else {
          expectRefusal(page);
        }
      }
      expect(await tenant.appointments()).toEqual([]);
    });
  });

  describe("more than 10 services", () => {
    const services = Array.from({ length: 12 }, (_, n) => ({ name: `Servicio ${String(n + 1).padStart(2, "0")}`, durationMinutes: 30 }));

    it("shows 9 plus a Más row and reaches the remaining 3 on the next page", async () => {
      const tenant = await harness.newTenant({ services });
      const customer = await tenant.namedCustomer(newPhone(), "Ana");

      const first = await customer.tap("menu:book");
      const more = replyIdsOf(first).at(-1) ?? "";
      const second = await customer.tap(more);

      expect(replyIdsOf(first)).toHaveLength(10);
      expect(replyIdsOf(first).slice(0, 9).every((id) => id.startsWith("svc:"))).toBe(true);
      expect(more).toMatch(/^svcs:9$/);
      expect(titlesOf(first).at(-1)).toMatch(/^Más/);
      expect(replyIdsOf(second)).toEqual(tenant.serviceIds.slice(9).map((id) => `svc:${id}`));
      expect(titlesOf(second)).toEqual(["Servicio 10", "Servicio 11", "Servicio 12"]);
      const reachable = [...replyIdsOf(first).slice(0, 9), ...replyIdsOf(second)];
      expect(reachable).toEqual(tenant.serviceIds.map((id) => `svc:${id}`));
      expect(more.length).toBeLessThanOrEqual(200);
    });

    it("books every one of the 12 services end to end, including those on the second page", { timeout: 30_000 }, async () => {
      const tenant = await harness.newTenant({ services });
      const customer = tenant.customer(newPhone());
      const pageTwo = replyIdsOf(await customer.tap("svcs:9"));
      expect(pageTwo).toEqual(tenant.serviceIds.slice(9).map((id) => `svc:${id}`));

      for (const serviceId of tenant.serviceIds) {
        const days = await customer.tap(`svc:${serviceId}`);
        const slots = await customer.tap(pick(days, "day:"));
        const confirmation = await customer.tap(pick(slots, "slot:"));
        const done = await customer.tap(pick(confirmation, "ok:"), "button_reply");
        expect(bodyOf(done)).toMatch(/confirmada/i);
      }

      const stored = await tenant.appointments();
      expect(stored.map((row) => row.serviceId).sort()).toEqual([...tenant.serviceIds].sort());
    });

    it("falls back to the first page for a stale offset and refuses a malformed one", async () => {
      const tenant = await harness.newTenant({ services });
      const customer = tenant.customer(newPhone());

      expect(replyIdsOf(await customer.tap("svcs:500"))[0]).toBe(`svc:${tenant.serviceIds[0]}`);
      for (const id of ["svcs:", "svcs:-1", "svcs:abc", "svcs:99999999999999999999"]) {
        expectRefusal(await customer.tap(id));
      }
    });

    it("pages only active services", async () => {
      const tenant = await harness.newTenant({
        services: [...services, { name: "Inactivo", durationMinutes: 30, active: false }],
      });

      const second = await tenant.customer(newPhone()).tap("svcs:9");

      expect(titlesOf(second)).toEqual(["Servicio 10", "Servicio 11", "Servicio 12"]);
    });
  });

  describe("when there is nothing to book", () => {
    it("says so when the business has no active services", async () => {
      const none = await harness.newTenant({ services: [] });
      const inactive = await harness.newTenant({ services: [{ name: "Viejo", durationMinutes: 30, active: false }] });

      for (const tenant of [none, inactive]) {
        const reply = await tenant.customer(newPhone()).tap("menu:book");
        expectMenu(reply);
        expect(bodyOf(reply)).toMatch(/no hay servicios/i);
      }
    });

    it("says so when the business has no opening hours", async () => {
      const tenant = await harness.newTenant({ hours: null });
      const serviceId = tenant.serviceIds[0] ?? "";

      const reply = await tenant.customer(newPhone()).tap(`svc:${serviceId}`);

      expectMenu(reply);
      expect(bodyOf(reply)).toMatch(/horarios/i);
      expect(bodyOf(reply)).toMatch(/no/i);
    });

    it("says there are no free slots when every slot of the next 7 days is taken", async () => {
      const tenant = await harness.newTenant({ hours: [{ weekday: 2, opensAt: "09:00", closesAt: "10:00" }] });
      const serviceId = tenant.serviceIds[0] ?? "";
      await tenant.bookDirect(serviceId, newPhone(), new Date("2031-03-11T14:00:00Z"), 30);
      await tenant.bookDirect(serviceId, newPhone(), new Date("2031-03-11T14:30:00Z"), 30);

      const reply = await tenant.customer(newPhone()).tap(`svc:${serviceId}`);

      expectMenu(reply);
      expect(bodyOf(reply)).toMatch(/no hay horarios disponibles/i);
    });

    it("leaves a full day out of the day list and explains if a stale day is chosen anyway", async () => {
      const tenant = await harness.newTenant({
        hours: [
          { weekday: 2, opensAt: "09:00", closesAt: "10:00" },
          { weekday: 3, opensAt: "09:00", closesAt: "10:00" },
        ],
      });
      const serviceId = tenant.serviceIds[0] ?? "";
      await tenant.bookDirect(serviceId, newPhone(), new Date("2031-03-11T14:00:00Z"), 30);
      await tenant.bookDirect(serviceId, newPhone(), new Date("2031-03-11T14:30:00Z"), 30);
      const customer = tenant.customer(newPhone());

      const days = await customer.tap(`svc:${serviceId}`);
      const stale = await customer.tap(`day:${serviceId}:2031-03-11`);

      expect(replyIdsOf(days)).toEqual([`day:${serviceId}:2031-03-12`]);
      expect(bodyOf(stale)).toMatch(/no quedan horarios/i);
      expect(replyIdsOf(stale)).toEqual([`day:${serviceId}:2031-03-12`]);
    });

    it("ignores cancelled appointments when computing free slots", async () => {
      const tenant = await harness.newTenant({ hours: [{ weekday: 2, opensAt: "09:00", closesAt: "10:00" }] });
      const serviceId = tenant.serviceIds[0] ?? "";
      const phone = newPhone();
      const booked = await tenant.bookDirect(serviceId, phone, new Date("2031-03-11T14:00:00Z"), 30);
      await tenant.customer(phone).tap(`cancelok:${booked.id}`);

      const slots = await tenant.customer(newPhone()).tap(`day:${serviceId}:2031-03-11`);

      expect(titlesOf(slots)).toEqual(["09:00", "09:30"]);
    });
  });

  describe("a slot taken between listing and confirming", () => {
    it("tells the customer politely, shows the slot list again and creates no second appointment", async () => {
      // Given - the customer reached the confirmation of 09:00
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const customer = tenant.customer(newPhone());
      await customer.tap(`slot:${serviceId}:2031-03-11T14:00:00.000Z`);
      // When - somebody else books it before the customer confirms
      await tenant.bookDirect(serviceId, newPhone(), new Date("2031-03-11T14:00:00Z"), 30);
      const reply = await customer.tap(`ok:${serviceId}:2031-03-11T14:00:00.000Z`, "button_reply");

      // Then
      expect(bodyOf(reply)).toContain("Ese horario se acaba de ocupar");
      expect(replyIdsOf(reply)).toEqual(
        ["14:30", "15:00", "15:30"].map((time) => `slot:${serviceId}:2031-03-11T${time}:00.000Z`),
      );
      expect(await tenant.appointments()).toHaveLength(1);
    });

    it("shows the other days when that day has no slot left after the one that was taken", async () => {
      const tenant = await harness.newTenant({
        hours: [
          { weekday: 2, opensAt: "09:00", closesAt: "09:30" },
          { weekday: 3, opensAt: "09:00", closesAt: "10:00" },
        ],
      });
      const serviceId = tenant.serviceIds[0] ?? "";
      await tenant.bookDirect(serviceId, newPhone(), new Date("2031-03-11T14:00:00Z"), 30);

      const reply = await tenant.customer(newPhone()).tap(`ok:${serviceId}:2031-03-11T14:00:00.000Z`);

      expect(bodyOf(reply)).toContain("Ese horario se acaba de ocupar");
      expect(replyIdsOf(reply)).toEqual([`day:${serviceId}:2031-03-12`]);
    });

    it("lets exactly one of two customers win when they confirm the same slot at the same time", { timeout: 30_000 }, async () => {
      const tenant = await harness.newTenant({ hours: [{ weekday: 2, opensAt: "08:00", closesAt: "20:00" }] });
      const serviceId = tenant.serviceIds[0] ?? "";

      for (let round = 0; round < 6; round++) {
        const startsAt = new Date(Date.parse("2031-03-11T13:00:00.000Z") + round * 30 * MINUTE).toISOString();
        const [one, two] = [tenant.customer(newPhone()), tenant.customer(newPhone())];

        const replies = await Promise.all([one, two].map((customer) => customer.tap(`ok:${serviceId}:${startsAt}`)));

        const winners = replies.filter((reply) => /confirmada/i.test(bodyOf(reply)));
        const losers = replies.filter((reply) => bodyOf(reply).includes("Ese horario se acaba de ocupar"));
        expect([winners.length, losers.length]).toEqual([1, 1]);
        const booked = (await tenant.appointments()).filter((row) => row.startsAt.toISOString() === startsAt);
        expect(booked).toHaveLength(1);
      }
    });
  });

  describe("re-confirming a slot the customer already booked", () => {
    const SLOT = "2031-03-11T14:00:00.000Z";

    it("says Ya tienes esa cita agendada and creates no second appointment, with a new wamid each time", async () => {
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const customer = tenant.customer(newPhone());
      expect(bodyOf(await customer.tap(`ok:${serviceId}:${SLOT}`))).toMatch(/confirmada/i);

      const again = await customer.tap(`ok:${serviceId}:${SLOT}`, "button_reply");
      const stale = await customer.tap(`slot:${serviceId}:${SLOT}`);

      for (const reply of [again, stale]) {
        expectMenu(reply);
        expect(bodyOf(reply)).toContain("Ya tienes esa cita agendada");
        expect(bodyOf(reply)).toContain("09:00");
        expect(bodyOf(reply)).not.toMatch(/se acaba de ocupar|confirmada/i);
      }
      expect(await tenant.appointments()).toHaveLength(1);
    });

    it("answers the same way when the same customer confirms concurrently with different wamids", { timeout: 30_000 }, async () => {
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const phone = newPhone();
      const options = { phoneNumberId: tenant.phoneNumberId, from: phone };

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => harness.post(replyPayload({ ...options, wamid: newWamid() }, `ok:${serviceId}:${SLOT}`, "button_reply"))),
      );

      expect(responses.map((res) => res.status)).toEqual(Array(6).fill(200));
      expect(await tenant.appointments()).toHaveLength(1);
      const bodies = tenant.customer(phone).inbox().map(bodyOf);
      expect(bodies).toHaveLength(6);
      expect(bodies.filter((body) => /confirmada/i.test(body))).toHaveLength(1);
      expect(bodies.filter((body) => body.includes("Ya tienes esa cita agendada"))).toHaveLength(5);
      expect(bodies.some((body) => /se acaba de ocupar/i.test(body))).toBe(false);
    });

    it("still tells a different customer that the slot was just taken", async () => {
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      await tenant.customer(newPhone()).tap(`ok:${serviceId}:${SLOT}`);

      const reply = await tenant.customer(newPhone()).tap(`ok:${serviceId}:${SLOT}`);

      expect(bodyOf(reply)).toContain("Ese horario se acaba de ocupar");
      expect(bodyOf(reply)).not.toContain("Ya tienes");
      expect(await tenant.appointments()).toHaveLength(1);
    });

    it("tells the customer it was just taken when their own booking of that time is another service or was cancelled", async () => {
      const tenant = await harness.newTenant({ services: [{ name: "Corte", durationMinutes: 30 }, { name: "Barba", durationMinutes: 30 }] });
      const [corte = "", barba = ""] = tenant.serviceIds;
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap(`ok:${corte}:${SLOT}`);

      const otherService = await customer.tap(`ok:${barba}:${SLOT}`);

      expect(bodyOf(otherService)).toContain("Ese horario se acaba de ocupar");
      const [mine] = await tenant.appointments();
      await customer.tap(`cancelok:${mine?.id}`);
      expect(bodyOf(await customer.tap(`ok:${corte}:${SLOT}`))).toMatch(/confirmada/i);
      expect((await tenant.appointments()).filter((row) => row.status === "booked")).toHaveLength(1);
    });
  });

  describe("forged, stale or malformed reply ids", () => {
    async function expectRefusedAndUnchanged(tenant: Tenant, customer: Customer, ids: string[]) {
      const before = await tenant.appointments();
      for (const id of ids) {
        expectRefusal(await customer.tap(id, id.startsWith("ok:") || id.startsWith("cancelok:") ? "button_reply" : "list_reply"));
      }
      expect(await tenant.appointments()).toEqual(before);
    }

    it("refuses another business's service id at every step", async () => {
      const tenant = await harness.newTenant();
      const other = await harness.newTenant({ services: [{ name: "Ajeno", durationMinutes: 30 }] });
      const foreign = other.serviceIds[0] ?? "";

      await expectRefusedAndUnchanged(tenant, tenant.customer(newPhone()), [
        `svc:${foreign}`,
        `day:${foreign}:2031-03-11`,
        `more:${foreign}:2031-03-11:0`,
        `slot:${foreign}:2031-03-11T14:00:00.000Z`,
        `ok:${foreign}:2031-03-11T14:00:00.000Z`,
      ]);
      expect(await other.appointments()).toEqual([]);
    });

    it("refuses an inactive service and an unknown service id", async () => {
      const tenant = await harness.newTenant({ services: [{ name: "Viejo", durationMinutes: 30, active: false }] });
      const inactive = tenant.serviceIds[0] ?? "";

      await expectRefusedAndUnchanged(tenant, tenant.customer(newPhone()), [
        `svc:${inactive}`,
        `ok:${inactive}:2031-03-11T14:00:00.000Z`,
        `svc:${randomUUID()}`,
        `ok:${randomUUID()}:2031-03-11T14:00:00.000Z`,
      ]);
    });

    it("refuses a slot in the past, even one that was valid when it was listed", async () => {
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      harness.clock.now = new Date("2031-03-10T15:00:00.000Z"); // 10:00: today's 09:00 is gone
      try {
        await expectRefusedAndUnchanged(tenant, tenant.customer(newPhone()), [
          `ok:${serviceId}:2031-03-10T14:00:00.000Z`,
          `slot:${serviceId}:2031-03-10T14:00:00.000Z`,
          `ok:${serviceId}:2031-03-03T14:00:00.000Z`,
          `day:${serviceId}:2031-03-03`,
          `day:${serviceId}:2000-01-01`,
        ]);
      } finally {
        harness.clock.now = new Date("2031-03-10T13:00:00.000Z");
      }
    });

    it("refuses times that are not on the slot grid, outside opening hours or beyond the 7-day window", async () => {
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";

      await expectRefusedAndUnchanged(tenant, tenant.customer(newPhone()), [
        `ok:${serviceId}:2031-03-11T14:07:00.000Z`, // off the 30-minute grid
        `ok:${serviceId}:2031-03-11T20:00:00.000Z`, // 15:00 local, closed
        `ok:${serviceId}:2031-03-11T15:45:00.000Z`, // would end after closing
        `ok:${serviceId}:2031-03-15T14:00:00.000Z`, // Saturday, closed
        `ok:${serviceId}:2031-04-15T14:00:00.000Z`, // open weekday but far beyond the window
        `day:${serviceId}:2031-04-15`,
        `ok:${serviceId}:2099-12-31T14:00:00.000Z`,
      ]);
    });

    it("refuses another customer's appointment id for both the cancel confirmation and the cancellation", async () => {
      const tenant = await harness.newTenant();
      const owner = newPhone();
      const appointment = await tenant.bookDirect(tenant.serviceIds[0] ?? "", owner, new Date("2031-03-11T14:00:00Z"), 30);
      const intruder = tenant.customer(newPhone());

      await expectRefusedAndUnchanged(tenant, intruder, [`cancel:${appointment.id}`, `cancelok:${appointment.id}`]);

      expect((await tenant.appointments())[0]?.status).toBe("booked");
    });

    it("refuses an appointment id of another business", async () => {
      const tenant = await harness.newTenant();
      const other = await harness.newTenant();
      const phone = newPhone();
      const foreign = await other.bookDirect(other.serviceIds[0] ?? "", phone, new Date("2031-03-11T14:00:00Z"), 30);

      // The same phone number is a customer of both businesses; it still cannot reach the other business's rows.
      await expectRefusedAndUnchanged(tenant, tenant.customer(phone), [`cancel:${foreign.id}`, `cancelok:${foreign.id}`]);

      expect((await other.appointments())[0]?.status).toBe("booked");
    });

    it("refuses cancelling a past, an already cancelled and an unknown appointment", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const serviceId = tenant.serviceIds[0] ?? "";
      const past = await tenant.bookDirect(serviceId, phone, new Date("2031-03-10T12:00:00Z"), 30);
      const future = await tenant.bookDirect(serviceId, phone, new Date("2031-03-11T14:00:00Z"), 30);
      const customer = tenant.customer(phone);
      expect(bodyOf(await customer.tap(`cancelok:${future.id}`, "button_reply"))).toMatch(/cancelada/i);

      await expectRefusedAndUnchanged(tenant, customer, [
        `cancel:${past.id}`,
        `cancelok:${past.id}`,
        `cancelok:${future.id}`,
        `cancel:${randomUUID()}`,
      ]);
    });

    it("refuses malformed ids without an error or a change", async () => {
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const customer = tenant.customer(newPhone());

      await expectRefusedAndUnchanged(tenant, customer, [
        "",
        "garbage",
        "svc:",
        "svc:not-a-uuid",
        `svc:${serviceId}:extra`,
        `svc:${serviceId.toUpperCase()}x`,
        `day:${serviceId}`,
        `day:${serviceId}:2031-13-45`,
        `day:${serviceId}:2031-02-30`,
        `day:${serviceId}:tomorrow`,
        `slot:${serviceId}`,
        `slot:${serviceId}:`,
        `slot:${serviceId}:not-a-date`,
        `ok:${serviceId}:2031-03-11T14:00:00Z`,
        `ok:${serviceId}:2031-03-11T14:00:00.000+00:00`,
        `ok:${serviceId}:2031-03-11 14:00`,
        "ok:::",
        "cancel:",
        "cancel:123",
        "cancelok:'; DROP TABLE appointments; --",
        `more:${serviceId}:2031-03-11`,
        "menu:",
        "MENU:BOOK",
        "x".repeat(500),
        "\u0000",
        "svc:\u0000",
      ]);
    });
  });

  describe("Mis citas", () => {
    it("lists only that phone's upcoming booked appointments", async () => {
      // Given - mine: two upcoming; not mine: someone else's, a cancelled one and a past one
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const phone = newPhone();
      await tenant.bookDirect(serviceId, phone, new Date("2031-03-11T14:00:00Z"), 30);
      await tenant.bookDirect(serviceId, phone, new Date("2031-03-12T15:30:00Z"), 30);
      await tenant.bookDirect(serviceId, newPhone(), new Date("2031-03-13T14:00:00Z"), 30);
      const cancelled = await tenant.bookDirect(serviceId, phone, new Date("2031-03-14T14:00:00Z"), 30);
      await tenant.bookDirect(serviceId, phone, new Date("2031-03-10T12:00:00Z"), 30); // 07:00 today, already past
      await tenant.customer(phone).tap(`cancelok:${cancelled.id}`);

      // When
      const reply = await tenant.customer(phone).tap("menu:mine", "button_reply");

      // Then
      expectMenu(reply);
      const body = bodyOf(reply);
      expect(body).toContain("mar 11 mar, 09:00");
      expect(body).toContain("mié 12 mar, 10:30");
      expect(body).not.toContain("jue 13 mar");
      expect(body).not.toContain("vie 14 mar");
      expect(body).not.toContain("lun 10 mar");
      expect(body.match(/Corte/g)).toHaveLength(2);
    });

    it("says there are none, to a customer who never booked and to one whose appointments are all past", async () => {
      const tenant = await harness.newTenant();
      const past = newPhone();
      await tenant.bookDirect(tenant.serviceIds[0] ?? "", past, new Date("2031-03-10T12:00:00Z"), 30);

      for (const phone of [newPhone(), past]) {
        const reply = await tenant.customer(phone).tap("menu:mine");
        expectMenu(reply);
        expect(bodyOf(reply)).toMatch(/no tienes citas/i);
      }
    });

    it("does not create a customer just for looking at the appointments", async () => {
      const tenant = await harness.newTenant();

      await tenant.customer(newPhone()).tap("menu:mine");
      await tenant.customer(newPhone()).tap("menu:cancel");

      expect(await tenant.appointments()).toEqual([]);
    });

    it("reaches all 12 upcoming appointments by paging, showing only the customer's own", async () => {
      // Given - 12 for the customer (one every 30 minutes from 09:00 on Tuesday) and 3 for somebody else
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const phone = newPhone();
      for (let n = 0; n < 12; n++) {
        await tenant.bookDirect(serviceId, phone, new Date(Date.parse("2031-03-11T14:00:00Z") + n * 30 * MINUTE), 30);
      }
      for (let n = 0; n < 3; n++) {
        await tenant.bookDirect(serviceId, newPhone(), new Date(Date.parse("2031-03-12T14:00:00Z") + n * 30 * MINUTE), 30);
      }
      const customer = tenant.customer(phone);

      // When
      const first = await customer.tap("menu:mine");
      const next = replyIdsOf(first).find((id) => id.startsWith("mine:"));
      const second = await customer.tap(next ?? "mine:missing");

      // Then - 10 lines and a button for the rest, then the last 2 with the plain menu
      expect(bodyOf(first).match(/Corte/g)).toHaveLength(10);
      expect(next).toBeDefined();
      expect(replyIdsOf(first).length).toBeLessThanOrEqual(3);
      expect(titlesOf(first).some((title) => /^Ver más/.test(title))).toBe(true);
      expect(bodyOf(second).match(/Corte/g)).toHaveLength(2);
      expectMenu(second);
      const lines = [first, second].flatMap((page) => bodyOf(page).split("\n").filter((line) => line.startsWith("• ")));
      expect(lines).toHaveLength(12);
      expect(new Set(lines).size).toBe(12);
      expect(lines.some((line) => line.includes("mié 12 mar"))).toBe(false);
      expect(lines[0]).toContain("mar 11 mar, 09:00");
      expect(lines[11]).toContain("mar 11 mar, 14:30");
    });

    it("falls back to the first page for a stale offset and refuses a malformed one", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      await tenant.bookDirect(tenant.serviceIds[0] ?? "", phone, new Date("2031-03-11T14:00:00Z"), 30);
      const customer = tenant.customer(phone);

      const stale = await customer.tap("mine:500");

      expect(bodyOf(stale)).toContain("mar 11 mar, 09:00");
      for (const id of ["mine:", "mine:-1", "mine:abc", "mine:1.5", "mine:99999999999999999999"]) {
        expectRefusal(await customer.tap(id));
      }
    });
  });

  describe("Cancelar", () => {
    it("lists the customer's upcoming appointments, asks to confirm, cancels and frees the slot for booking again", async () => {
      // Given
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const phone = newPhone();
      const mine = await tenant.bookDirect(serviceId, phone, new Date("2031-03-11T14:00:00Z"), 30);
      await tenant.bookDirect(serviceId, newPhone(), new Date("2031-03-11T14:30:00Z"), 30);
      const customer = tenant.customer(phone);

      // When
      const list = await customer.tap("menu:cancel", "button_reply");
      const ask = await customer.tap(`cancel:${mine.id}`);
      const done = await customer.tap(`cancelok:${mine.id}`, "button_reply");

      // Then
      expect(replyIdsOf(list)).toEqual([`cancel:${mine.id}`]);
      expect(replyIdsOf(ask)).toEqual([`cancelok:${mine.id}`, "menu:home"]);
      expect(bodyOf(ask)).toContain("09:00");
      expectMenu(done);
      expect(bodyOf(done)).toMatch(/cancelada/i);
      const stored = await tenant.appointments();
      expect(stored.find((row) => row.id === mine.id)?.status).toBe("cancelled");
      expect(stored).toHaveLength(2);

      // And - the slot can be booked again, by anybody
      const slots = await tenant.customer(newPhone()).tap(`day:${serviceId}:2031-03-11`);
      expect(replyIdsOf(slots)).toContain(`slot:${serviceId}:2031-03-11T14:00:00.000Z`);
      const newcomer = newPhone();
      const rebooked = await tenant.customer(newcomer).tap(`ok:${serviceId}:2031-03-11T14:00:00.000Z`);
      expect(bodyOf(rebooked)).toMatch(/confirmada/i);
      expect((await tenant.appointments()).filter((row) => row.status === "booked" && row.customerPhone === newcomer)).toHaveLength(1);
    });

    it("keeps the appointment when the customer answers No, volver (menu:home)", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const mine = await tenant.bookDirect(tenant.serviceIds[0] ?? "", phone, new Date("2031-03-11T14:00:00Z"), 30);
      const customer = tenant.customer(phone);
      await customer.tap(`cancel:${mine.id}`);

      expectMenu(await customer.tap("menu:home", "button_reply"));

      expect((await tenant.appointments())[0]?.status).toBe("booked");
    });

    it("says there is nothing to cancel when the customer has no upcoming appointments", async () => {
      const tenant = await harness.newTenant();

      const reply = await tenant.customer(newPhone()).tap("menu:cancel");

      expectMenu(reply);
      expect(bodyOf(reply)).toMatch(/no tienes citas/i);
    });

    it("reaches all 12 upcoming appointments through Más citas, each cancellable, and never lists another customer's", async () => {
      const tenant = await harness.newTenant();
      const serviceId = tenant.serviceIds[0] ?? "";
      const phone = newPhone();
      const mine = [];
      for (let n = 0; n < 12; n++) {
        mine.push(await tenant.bookDirect(serviceId, phone, new Date(Date.parse("2031-03-11T14:00:00Z") + n * 30 * MINUTE), 30));
      }
      const others = [];
      for (let n = 0; n < 3; n++) {
        others.push(await tenant.bookDirect(serviceId, newPhone(), new Date(Date.parse("2031-03-12T14:00:00Z") + n * 30 * MINUTE), 30));
      }
      const customer = tenant.customer(phone);

      const first = await customer.tap("menu:cancel");
      const more = replyIdsOf(first).find((id) => id.startsWith("cmore:"));
      const second = await customer.tap(more ?? "cmore:missing");

      expect(replyIdsOf(first)).toHaveLength(10);
      expect(titlesOf(first).at(-1)).toMatch(/^Más/);
      expect(replyIdsOf(second)).toHaveLength(3);
      expect(replyIdsOf(second).some((id) => id.startsWith("cmore:"))).toBe(false);
      const listed = [...replyIdsOf(first), ...replyIdsOf(second)].filter((id) => id.startsWith("cancel:"));
      expect(listed.sort()).toEqual(mine.map((row) => `cancel:${row.id}`).sort());
      for (const other of others) expect(listed).not.toContain(`cancel:${other.id}`);

      // And - one from the second page can be cancelled
      const target = replyIdsOf(second)[0] ?? "";
      expect(bodyOf(await customer.tap(target))).toMatch(/cancelar esta cita/i);
      expect(bodyOf(await customer.tap(target.replace("cancel:", "cancelok:")))).toMatch(/cancelada/i);
      expect((await tenant.appointments()).filter((row) => row.status === "cancelled")).toHaveLength(1);
    });

    it("falls back to the first page for a stale offset and refuses a malformed one", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const booked = await tenant.bookDirect(tenant.serviceIds[0] ?? "", phone, new Date("2031-03-11T14:00:00Z"), 30);
      const customer = tenant.customer(phone);

      expect(replyIdsOf(await customer.tap("cmore:500"))).toEqual([`cancel:${booked.id}`]);
      for (const id of ["cmore:", "cmore:-1", "cmore:abc", "cmore:99999999999999999999"]) {
        expectRefusal(await customer.tap(id));
      }
    });
  });

  describe("WhatsApp limits on generated text", () => {
    it("truncates long and awkward service names with an ellipsis in every list and confirmation", async () => {
      // Given - names that overflow titles, descriptions and bodies (the fake client checks every message it receives)
      const long = "Tratamiento capilar completo con keratina, corte y peinado de fiesta";
      const tenant = await harness.newTenant({
        services: [
          { name: long, durationMinutes: 45 },
          { name: `  Corte\nde\tpelo ${"é".repeat(150)}`.slice(0, 120), durationMinutes: 30 },
          { name: `${"a".repeat(23)}😀😀😀`, durationMinutes: 30 },
        ],
      });
      const [first, second, third] = tenant.serviceIds;
      const customer = await tenant.namedCustomer(newPhone(), "Ana");

      // When
      const services = await customer.tap("menu:book");
      await customer.tap(`svc:${first}`);
      await customer.tap(`svc:${second}`);
      await customer.tap(`svc:${third}`);
      const confirm = await customer.tap(`slot:${first}:2031-03-11T14:00:00.000Z`);
      const booked = await customer.tap(`ok:${first}:2031-03-11T14:00:00.000Z`);
      const mine = await customer.tap("menu:mine");
      const cancel = await customer.tap("menu:cancel");

      // Then
      expect(titlesOf(services)[0]).toBe("Tratamiento capilar com…");
      expect(titlesOf(services).every((title) => title.length <= 24)).toBe(true);
      expect(titlesOf(services)[1]).not.toMatch(/[\n\t]/);
      expect(titlesOf(services)[2]).toBe(`${"a".repeat(23)}…`);
      expect(bodyOf(confirm)).toContain("Tratamiento");
      expect(bodyOf(booked).length).toBeLessThanOrEqual(1024);
      expect(bodyOf(mine).length).toBeLessThanOrEqual(1024);
      expect(titlesOf(cancel).every((title) => title.length <= 24)).toBe(true);
    });

    it("stays within limits with a very long business name", async () => {
      const tenant = await harness.newTenant({ name: `${"Peluquería ".repeat(60)}${randomUUID()}` });
      const menu = await tenant.customer(newPhone()).say("hola");

      expect(bodyOf(menu).length).toBeLessThanOrEqual(1024);
    });
  });
});
