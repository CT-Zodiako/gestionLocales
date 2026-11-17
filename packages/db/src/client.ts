import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10 });
  const db = drizzle(client, { schema });
  return {
    db,
    /** Throws when the database is unreachable. */
    async ping(): Promise<void> {
      await db.execute(sql`select 1`);
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
}

export type Database = ReturnType<typeof createDb>["db"];
