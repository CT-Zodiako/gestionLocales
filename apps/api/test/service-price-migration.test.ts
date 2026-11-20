import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, sql } from "@gestion/db";
import { databaseUrl } from "./support/env.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
const LAST_BEFORE_PRICE = "0005_appointment_reminders";

function codeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** The SQLSTATE of the error a statement raises; fails the test when it succeeds. */
async function failureCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return codeOf(error);
  }
  throw new Error("expected the statement to fail");
}

describe("migration 0006: service price and pending names", () => {
  const admin = createDb(databaseUrl);
  const scratchNames: string[] = [];
  const folders: string[] = [];

  function scratchUrl(name: string): string {
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    return url.toString();
  }

  async function newScratchDatabase(): Promise<{ name: string; url: string }> {
    const name = `gestion_scratch_${randomUUID().replaceAll("-", "")}`;
    await admin.db.execute(sql.raw(`create database "${name}"`));
    scratchNames.push(name);
    return { name, url: scratchUrl(name) };
  }

  /** A copy of the migrations folder whose journal stops at migration 0005, as a database from before this change would have it. */
  function migrationsUpTo0005(): string {
    const folder = mkdtempSync(join(tmpdir(), "gestion-migrations-"));
    folders.push(folder);
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    const last = journal.entries.findIndex((entry) => entry.tag === LAST_BEFORE_PRICE);
    if (last < 0) throw new Error("migration 0005 not found in the journal");
    journal.entries = journal.entries.slice(0, last + 1);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    return folder;
  }

  afterAll(async () => {
    for (const name of scratchNames) {
      await admin.db.execute(sql.raw(`drop database if exists "${name}" with (force)`));
    }
    await admin.close();
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  async function expectCurrentShape(url: string) {
    const database = createDb(url);
    try {
      const { db } = database;
      const columns = await db.execute<{ column_name: string; data_type: string; is_nullable: string }>(
        sql`select column_name, data_type, is_nullable from information_schema.columns where table_name = 'services' and column_name = 'price'`,
      );
      expect(columns).toEqual([{ column_name: "price", data_type: "integer", is_nullable: "YES" }]);

      const pending = await db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_name = 'whatsapp_pending_names' order by column_name`,
      );
      expect(pending.map((row) => row.column_name)).toEqual(["attempts", "business_id", "created_at", "expires_at", "phone"]);

      const [business] = await db.execute<{ id: string }>(sql`insert into businesses (name) values (${`Migration ${randomUUID()}`}) returning id`);
      const businessId = business?.id ?? "";
      const insertService = (price: number | null) =>
        db.execute(sql`insert into services (business_id, name, duration_minutes, price) values (${businessId}, 'Corte', 30, ${price})`);

      await insertService(null);
      await insertService(0);
      await insertService(25000);
      await insertService(100_000_000);
      expect(await failureCode(() => insertService(-1))).toBe("23514");
      expect(await failureCode(() => insertService(100_000_001))).toBe("23514");

      const insertPending = (id: string, phone: string, attempts = 0) =>
        db.execute(
          sql`insert into whatsapp_pending_names (business_id, phone, attempts, expires_at) values (${id}, ${phone}, ${attempts}, now() + interval '10 minutes')`,
        );
      await insertPending(businessId, "573001112233");
      expect(await failureCode(() => insertPending(businessId, "573001112233"))).toBe("23505");
      await insertPending(businessId, "573001112244");
      expect(await failureCode(() => insertPending(randomUUID(), "573001112255"))).toBe("23503");
      expect(await failureCode(() => insertPending(businessId, "573001112266", -1))).toBe("23514");

      // The unique key is business + phone: the same phone in another business is a different row.
      const [other] = await db.execute<{ id: string }>(sql`insert into businesses (name) values (${`Migration ${randomUUID()}`}) returning id`);
      await insertPending(other?.id ?? "", "573001112233");
    } finally {
      await database.close();
    }
  }

  it("applies on a fresh database and produces the final shape and constraints", async () => {
    const scratch = await newScratchDatabase();

    await runMigrations(scratch.url);

    await expectCurrentShape(scratch.url);
  });

  it("applies on top of 0005 with existing rows, keeping them and giving old services price null", async () => {
    // Given - a database at 0005 with a business, a service, a customer, an appointment and a reminder
    const scratch = await newScratchDatabase();
    await runMigrations(scratch.url, { migrationsFolder: migrationsUpTo0005() });
    const before = createDb(scratch.url);
    const ids = { business: randomUUID(), service: randomUUID(), customer: randomUUID(), appointment: randomUUID() };
    try {
      const { db } = before;
      expect(
        await db.execute(sql`select 1 from information_schema.columns where table_name = 'services' and column_name = 'price'`),
      ).toHaveLength(0);
      await db.execute(sql`insert into businesses (id, name) values (${ids.business}, 'Antes de 0006')`);
      await db.execute(
        sql`insert into services (id, business_id, name, duration_minutes) values (${ids.service}, ${ids.business}, 'Corte', 30)`,
      );
      await db.execute(sql`insert into customers (id, business_id, phone, name) values (${ids.customer}, ${ids.business}, '573001234567', 'Ana')`);
      await db.execute(
        sql`insert into appointments (id, business_id, customer_id, service_id, starts_at, ends_at) values (${ids.appointment}, ${ids.business}, ${ids.customer}, ${ids.service}, '2031-03-11T14:00:00Z', '2031-03-11T14:30:00Z')`,
      );
      await db.execute(
        sql`insert into appointment_reminders (business_id, appointment_id, kind, due_at) values (${ids.business}, ${ids.appointment}, 'confirmation', '2031-03-10T13:00:00Z')`,
      );
    } finally {
      await before.close();
    }

    // When - the current migrations are applied (twice: re-running is a no-op)
    await runMigrations(scratch.url);
    await runMigrations(scratch.url);

    // Then - everything is still there and the old service has no price
    const after = createDb(scratch.url);
    try {
      const { db } = after;
      expect(await db.execute(sql`select name, duration_minutes, active, price from services where id = ${ids.service}`)).toEqual([
        { name: "Corte", duration_minutes: 30, active: true, price: null },
      ]);
      expect(await db.execute(sql`select name from customers where id = ${ids.customer}`)).toEqual([{ name: "Ana" }]);
      expect(await db.execute(sql`select status from appointments where id = ${ids.appointment}`)).toEqual([{ status: "booked" }]);
      expect(await db.execute(sql`select status from appointment_reminders where appointment_id = ${ids.appointment}`)).toEqual([
        { status: "pending" },
      ]);
      await db.execute(sql`update services set price = 25000 where id = ${ids.service}`);
      expect(await db.execute(sql`select price from services where id = ${ids.service}`)).toEqual([{ price: 25000 }]);
    } finally {
      await after.close();
    }
    await expectCurrentShape(scratch.url);
  });
});
