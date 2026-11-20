import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBusiness, removeBusinessIfUnreferenced, removeBusinessWithAgenda, sql, upsertCustomer } from "@gestion/db";
import type { OutgoingMessage } from "../src/whatsapp/messages.ts";
import { newWamid, replyPayload, textPayload } from "./support/whatsapp.ts";
import {
  MENU_IDS,
  MINUTE,
  bodyOf,
  createHarness,
  pick,
  replyIdsOf,
  titlesOf,
  type Harness,
  type Tenant,
} from "./support/whatsapp-harness.ts";
import { remindersOf } from "./support/reminders.ts";

const newPhone = () => `57300${randomInt(1_000_000, 9_999_999)}`;
const PROMPT = "¿Cómo te llamas? Escribe tu nombre para continuar.";

/** The reply is the question for the name: a plain text message with no buttons. */
function expectPrompt(message: OutgoingMessage): void {
  expect(message.type).toBe("text");
  expect(bodyOf(message)).toBe(PROMPT);
}

/** The reply is the list of active services. */
function expectServices(message: OutgoingMessage, tenant: Tenant): void {
  expect(message.type).toBe("interactive");
  expect(replyIdsOf(message)).toEqual(tenant.serviceIds.map((id) => `svc:${id}`));
}

function expectMenu(message: OutgoingMessage): void {
  expect(message.type).toBe("interactive");
  expect(replyIdsOf(message)).toEqual(MENU_IDS);
}

describe("customer name step in the WhatsApp bot", () => {
  let harness: Harness;
  const baseClock = new Date("2031-03-10T13:00:00.000Z");

  beforeAll(async () => {
    harness = await createHarness({ reminders: true });
  });

  afterAll(async () => {
    harness.clock.now = baseClock;
    await harness.close();
  });

  describe("happy path", () => {
    it("asks for the name on the first Agendar, stores it, continues to the services and never asks again", async () => {
      // Given - a customer the business has never seen
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      expect(await tenant.customerName(phone)).toBeUndefined();

      // When - Agendar, then the name
      const prompt = await customer.tap("menu:book", "button_reply");
      const [pending] = await tenant.pendingNames(phone);
      const services = await customer.say("  María   José ");

      // Then
      expectPrompt(prompt);
      expect(pending).toMatchObject({ attempts: 0 });
      expect(pending?.expiresAt.getTime()).toBe(harness.clock.now.getTime() + 10 * MINUTE);
      expectServices(services, tenant);
      expect(bodyOf(services)).toContain("María José");
      expect(titlesOf(services)).toEqual(["Corte"]);
      expect(await tenant.customerName(phone)).toBe("María José");
      expect(await tenant.pendingNames(phone)).toEqual([]);

      // And - the next Agendar goes straight to the services, and the booking carries the name
      const again = await customer.tap("menu:book", "button_reply");
      expectServices(again, tenant);
      expect(bodyOf(again)).not.toContain("María");
      const serviceId = tenant.serviceIds[0] ?? "";
      const days = await customer.tap(`svc:${serviceId}`);
      const slots = await customer.tap(pick(days, "day:"));
      const question = await customer.tap(pick(slots, "slot:"));
      await customer.tap(pick(question, "ok:"), "button_reply");
      const [stored] = await tenant.appointments();
      expect(stored).toMatchObject({ customerPhone: phone, customerName: "María José" });
    });

    it("lets the reminders use the stored name", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      const serviceId = tenant.serviceIds[0] ?? "";
      await customer.tap("menu:book");
      await customer.say("Camila");

      const days = await customer.tap(`svc:${serviceId}`);
      const slots = await customer.tap(pick(days, "day:"));
      const question = await customer.tap(pick(slots, "slot:"));
      await customer.tap(pick(question, "ok:"), "button_reply");
      const summary = await harness.sweep();

      expect(summary.sent).toBeGreaterThanOrEqual(1);
      const [template] = harness.client.templatesTo(phone);
      expect(template?.message.template.components[0]?.parameters[0]?.text).toBe("Camila");
      const [booked] = await tenant.appointments();
      expect(await remindersOf(harness, booked?.id ?? "")).toContainEqual(expect.objectContaining({ kind: "confirmation", status: "sent" }));
    });

    it.each([
      ["a simple name", "Ana", "Ana"],
      ["two letters", "Li", "Li"],
      ["an apostrophe", "O'Brien", "O'Brien"],
      ["a typographic apostrophe", "D’Angelo", "D’Angelo"],
      ["a hyphen and a dot", "Jean-Luc Picard Jr.", "Jean-Luc Picard Jr."],
      ["accents and ñ", "Ñandú Núñez Çelik", "Ñandú Núñez Çelik"],
      ["a line break inside", "Ana\nMaría", "Ana María"],
      ["tabs and runs of spaces", "\tAna \t  María Paz ", "Ana María Paz"],
      ["exactly 60 characters", "a".repeat(60), "a".repeat(60)],
    ])("accepts %s", async (_label, text, stored) => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");

      const reply = await customer.say(text);

      expectServices(reply, tenant);
      expect(await tenant.customerName(phone)).toBe(stored);
    });
  });

  describe("invalid names", () => {
    it.each([
      ["one character", "A"],
      ["61 characters", "a".repeat(61)],
      ["digits", "Juan 123"],
      ["only digits", "123456"],
      ["markup", "<b>Ana</b>"],
      ["an SQL fragment", "Robert'); DROP TABLE customers;--"],
      ["an emoji", "Ana 😀"],
      ["only punctuation", "..."],
      ["a leading hyphen", "-Ana"],
      ["only spaces", "     "],
      ["an empty text", ""],
      ["a url", "ana.com/x"],
      ["an at sign", "ana@mail"],
    ])("asks again with a hint for %s and stores nothing", async (_label, text) => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");

      const reply = await customer.say(text);

      expect(reply.type).toBe("text");
      expect(bodyOf(reply)).toMatch(/entre 2 y 60/);
      expect(bodyOf(reply)).toContain("¿Cómo te llamas?");
      expect(await tenant.customerName(phone)).not.toEqual(expect.any(String));
      expect(await tenant.pendingNames(phone)).toHaveLength(1);
      expect(await tenant.appointments()).toEqual([]);
    });

    it("accepts a valid name after one invalid attempt", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");

      const hint = await customer.say("12345");
      const [afterHint] = await tenant.pendingNames(phone);
      const services = await customer.say("Valentina");

      expect(bodyOf(hint)).toMatch(/entre 2 y 60/);
      expect(afterHint).toMatchObject({ attempts: 1 });
      expectServices(services, tenant);
      expect(await tenant.customerName(phone)).toBe("Valentina");
      expect(await tenant.pendingNames(phone)).toEqual([]);
    });

    it("gives up after the second invalid attempt: main menu, nothing stored, and Agendar asks again", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");
      await customer.say("12345");

      const second = await customer.say("67890");

      expectMenu(second);
      expect(bodyOf(second)).toMatch(/no pude guardar tu nombre/i);
      expect(await tenant.customerName(phone)).not.toEqual(expect.any(String));
      expect(await tenant.pendingNames(phone)).toEqual([]);
      expectMenu(await customer.say("Ana"));
      expectPrompt(await customer.tap("menu:book"));
      expect(await tenant.pendingNames(phone)).toHaveLength(1);
    });
  });

  describe("buttons instead of text", () => {
    it.each([
      ["Mis citas", "menu:mine"],
      ["Cancelar", "menu:cancel"],
      ["the main menu", "menu:home"],
      ["a stale service id", `svc:${randomUUID()}`],
      ["an unknown id", "nonsense:1"],
    ])("clears the pending state when %s is tapped and answers that button normally", async (_label, id) => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");
      expect(await tenant.pendingNames(phone)).toHaveLength(1);

      const reply = await customer.tap(id);

      expect(reply.type).toBe("interactive");
      expect(bodyOf(reply)).not.toBe(PROMPT);
      expect(await tenant.pendingNames(phone)).toEqual([]);

      // The next text is just text: the main menu, and no name is stored from it.
      expectMenu(await customer.say("Ana"));
      expect(await tenant.customerName(phone)).not.toEqual(expect.any(String));
    });

    it("asks again, with a single pending row, when Agendar is tapped twice", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);

      expectPrompt(await customer.tap("menu:book"));
      expectPrompt(await customer.tap("menu:book"));

      expect(await tenant.pendingNames(phone)).toHaveLength(1);
    });
  });

  describe("expiry", () => {
    it("treats the text as plain text once 10 minutes have passed", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");

      harness.clock.now = new Date(baseClock.getTime() + 10 * MINUTE);
      try {
        const reply = await customer.say("Ana");

        expectMenu(reply);
        expect(bodyOf(reply)).not.toContain("Gracias");
        expect(await tenant.customerName(phone)).not.toEqual(expect.any(String));
      } finally {
        harness.clock.now = baseClock;
      }
    });

    it("still accepts the name 9 minutes and 59 seconds after the question", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");

      harness.clock.now = new Date(baseClock.getTime() + 10 * MINUTE - 1000);
      try {
        expectServices(await customer.say("Ana"), tenant);
        expect(await tenant.customerName(phone)).toBe("Ana");
      } finally {
        harness.clock.now = baseClock;
      }
    });

    it("ignores the text at exactly 10:00.000 after the question and accepts it 1 ms earlier", async () => {
      const tenant = await harness.newTenant();
      const [late, early] = [newPhone(), newPhone()];
      await tenant.customer(late).tap("menu:book");
      await tenant.customer(early).tap("menu:book");

      try {
        harness.clock.now = new Date(baseClock.getTime() + 10 * MINUTE - 1);
        expectServices(await tenant.customer(early).say("Ana"), tenant);
        expect(await tenant.customerName(early)).toBe("Ana");
        expect(await tenant.pendingNames(early)).toEqual([]);

        harness.clock.now = new Date(baseClock.getTime() + 10 * MINUTE);
        const reply = await tenant.customer(late).say("Ana");
        expectMenu(reply);
        expect(bodyOf(reply)).not.toContain("Gracias");
        expect(await tenant.customerName(late)).toBeUndefined();
      } finally {
        harness.clock.now = baseClock;
      }
    });

    it("asks again for a fresh 10 minutes when Agendar is tapped after an expired question", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");

      const later = new Date(baseClock.getTime() + 30 * MINUTE);
      harness.clock.now = later;
      try {
        expectPrompt(await customer.tap("menu:book"));
        const [fresh] = await tenant.pendingNames(phone);
        expect(fresh?.expiresAt.getTime()).toBe(later.getTime() + 10 * MINUTE);
        expect(fresh).toMatchObject({ attempts: 0 });
        expectServices(await customer.say("Ana"), tenant);
      } finally {
        harness.clock.now = baseClock;
      }
    });

    it("does not extend the 10 minutes with an invalid attempt", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");
      const [first] = await tenant.pendingNames(phone);

      harness.clock.now = new Date(baseClock.getTime() + 5 * MINUTE);
      try {
        await customer.say("12345");
        const [after] = await tenant.pendingNames(phone);
        expect(after?.expiresAt.getTime()).toBe(first?.expiresAt.getTime());
      } finally {
        harness.clock.now = baseClock;
      }
    });
  });

  describe("an existing name", () => {
    it("is never asked for again and never overwritten by a later text", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = await tenant.namedCustomer(phone, "Pedro Pérez");

      const services = await customer.tap("menu:book");
      const reply = await customer.say("Otro Nombre");

      expectServices(services, tenant);
      expect(await tenant.pendingNames(phone)).toEqual([]);
      expectMenu(reply);
      expect(await tenant.customerName(phone)).toBe("Pedro Pérez");
    });

    it("keeps a name stored while the question was pending (the owner booked the customer meanwhile)", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");
      await upsertCustomer(harness.server.db, { businessId: tenant.businessId, phone, name: "Laura Gómez" });

      const reply = await customer.say("Ana");

      expectServices(reply, tenant);
      expect(await tenant.customerName(phone)).toBe("Laura Gómez");
      expect(await tenant.pendingNames(phone)).toEqual([]);
    });

    it("asks for a name when the customer exists without one (booked by the owner with no name)", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      await upsertCustomer(harness.server.db, { businessId: tenant.businessId, phone });
      const customer = tenant.customer(phone);

      expectPrompt(await customer.tap("menu:book"));
      expectServices(await customer.say("Sofía"), tenant);

      expect(await tenant.customerName(phone)).toBe("Sofía");
    });
  });

  describe("isolation", () => {
    it("keeps the pending state per business: the same phone in another business is not asked, and its text is not a name", async () => {
      const [first, second] = [await harness.newTenant(), await harness.newTenant()];
      const phone = newPhone();
      await first.customer(phone).tap("menu:book");

      const reply = await second.customer(phone).say("Ana");

      expectMenu(reply);
      expect(await second.customerName(phone)).toBeUndefined();
      expect(await first.pendingNames(phone)).toHaveLength(1);
      expect(await second.pendingNames(phone)).toEqual([]);
      expectServices(await first.customer(phone).say("Ana"), first);
      expect(await first.customerName(phone)).toBe("Ana");
      expect(await second.customerName(phone)).toBeUndefined();
    });

    it("keeps the pending state per phone", async () => {
      const tenant = await harness.newTenant();
      const [one, other] = [newPhone(), newPhone()];
      await tenant.customer(one).tap("menu:book");

      const reply = await tenant.customer(other).say("Ana");

      expectMenu(reply);
      expect(await tenant.customerName(other)).toBeUndefined();
      expect(await tenant.pendingNames(one)).toHaveLength(1);
    });

    it("does not ask for a name when there is nothing to book", async () => {
      const tenant = await harness.newTenant({ services: [] });
      const phone = newPhone();

      const reply = await tenant.customer(phone).tap("menu:book");

      expectMenu(reply);
      expect(bodyOf(reply)).toMatch(/no hay servicios/i);
      expect(await tenant.pendingNames(phone)).toEqual([]);
    });
  });

  describe("duplicate and concurrent deliveries", () => {
    it("does not double-process the same wamid of the Agendar tap or of the name", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const options = { phoneNumberId: tenant.phoneNumberId, from: phone };
      const tapWamid = newWamid();
      const nameWamid = newWamid();
      const tap = replyPayload({ ...options, wamid: tapWamid }, "menu:book", "button_reply");

      await Promise.all([harness.post(tap), harness.post(tap), harness.post(tap)]);
      expect(harness.client.messagesTo(phone)).toHaveLength(1);
      expectPrompt(harness.client.messagesTo(phone)[0] as OutgoingMessage);

      const name = textPayload({ ...options, wamid: nameWamid }, "Ana");
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => harness.post(name)));
      await harness.post(name);

      expect(results.every((res) => res.status === 200)).toBe(true);
      const inbox = harness.client.messagesTo(phone);
      expect(inbox).toHaveLength(2);
      expectServices(inbox[1] as OutgoingMessage, tenant);
      expect(await tenant.customerName(phone)).toBe("Ana");
      expect(await tenant.pendingNames(phone)).toEqual([]);
    });

    it("lets exactly one of two racing names win and answers the other as plain text", async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const customer = tenant.customer(phone);
      await customer.tap("menu:book");
      const options = { phoneNumberId: tenant.phoneNumberId, from: phone };
      const before = harness.client.messagesTo(phone).length;

      await Promise.all([
        harness.post(textPayload({ ...options, wamid: newWamid() }, "Ana")),
        harness.post(textPayload({ ...options, wamid: newWamid() }, "Bea")),
      ]);

      const replies = harness.client.messagesTo(phone).slice(before);
      expect(replies).toHaveLength(2);
      const services = replies.filter((reply) => replyIdsOf(reply).some((id) => id.startsWith("svc:")));
      const menus = replies.filter((reply) => JSON.stringify(replyIdsOf(reply)) === JSON.stringify(MENU_IDS));
      expect(services).toHaveLength(1);
      expect(menus).toHaveLength(1);
      expect(["Ana", "Bea"]).toContain(await tenant.customerName(phone));
    });
  });

  describe("heavy races", () => {
    const customerRows = async (tenant: Tenant, phone: string) =>
      (await harness.server.db.execute(sql`select 1 from customers where business_id = ${tenant.businessId} and phone = ${phone}`)).length;
    const gracias = (phone: string) => harness.client.messagesTo(phone).filter((message) => bodyOf(message).includes("Gracias"));

    it("leaves exactly one Gracias, one customer row and no pending row when 20 different names race, in 5 rounds", { timeout: 60_000 }, async () => {
      const tenant = await harness.newTenant();

      for (let round = 0; round < 5; round++) {
        const phone = newPhone();
        const options = { phoneNumberId: tenant.phoneNumberId, from: phone };
        expectPrompt(await tenant.customer(phone).tap("menu:book"));

        const responses = await Promise.all(
          Array.from({ length: 20 }, (_, n) =>
            harness.post(textPayload({ ...options, wamid: newWamid() }, `Nombre${String.fromCharCode(65 + n)}`)),
          ),
        );

        expect(responses.map((res) => res.status)).toEqual(Array(20).fill(200));
        expect(gracias(phone)).toHaveLength(1);
        expect(harness.client.messagesTo(phone)).toHaveLength(21); // the prompt, one Gracias and 19 answers as plain text
        expect(await customerRows(tenant, phone)).toBe(1);
        expect(await tenant.customerName(phone)).toMatch(/^Nombre[A-T]$/);
        expect(await tenant.pendingNames(phone)).toEqual([]);
      }
    });

    it("leaves exactly one pending row when 20 Agendar taps race", { timeout: 60_000 }, async () => {
      const tenant = await harness.newTenant();
      const phone = newPhone();
      const options = { phoneNumberId: tenant.phoneNumberId, from: phone };

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => harness.post(replyPayload({ ...options, wamid: newWamid() }, "menu:book", "button_reply"))),
      );

      expect(responses.map((res) => res.status)).toEqual(Array(20).fill(200));
      expect(await tenant.pendingNames(phone)).toHaveLength(1);
      expect(await tenant.pendingNames(phone)).toEqual([{ attempts: 0, expiresAt: new Date(baseClock.getTime() + 10 * MINUTE) }]);
      expect(harness.client.messagesTo(phone)).toHaveLength(20);
      expect(await customerRows(tenant, phone)).toBe(0);
    });
  });

  describe("business removal", () => {
    it("blocks removeBusinessIfUnreferenced while a pending name exists, and removeBusinessWithAgenda clears it", async () => {
      const db = harness.server.db;
      const [guarded, wiped] = [
        await ensureBusiness(db, `Pending name ${randomUUID()}`),
        await ensureBusiness(db, `Pending name ${randomUUID()}`),
      ];
      const phone = newPhone();
      const insert = (businessId: string) =>
        db.execute(sql`insert into whatsapp_pending_names (business_id, phone, expires_at) values (${businessId}, ${phone}, now() + interval '10 minutes')`);
      const exists = async (id: string) => (await db.execute(sql`select 1 from businesses where id = ${id}`)).length === 1;
      await insert(guarded.id);
      await insert(wiped.id);

      try {
        await removeBusinessIfUnreferenced(db, guarded.id);
        expect(await exists(guarded.id)).toBe(true);

        await db.execute(sql`delete from whatsapp_pending_names where business_id = ${guarded.id}`);
        await removeBusinessIfUnreferenced(db, guarded.id);
        expect(await exists(guarded.id)).toBe(false);

        await removeBusinessWithAgenda(db, wiped.id);
        expect(await exists(wiped.id)).toBe(false);
        const left = await db.execute(sql`select 1 from whatsapp_pending_names where business_id = ${wiped.id}`);
        expect(left).toHaveLength(0);
      } finally {
        await removeBusinessWithAgenda(db, guarded.id);
        await removeBusinessWithAgenda(db, wiped.id);
      }
    });
  });
});
