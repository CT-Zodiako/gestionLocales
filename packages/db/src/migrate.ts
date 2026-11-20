import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export interface MigrationOptions {
  /** Folder holding the SQL files and `meta/_journal.json`; the package's own migrations by default (tests point it at a copy cut at an older migration). */
  migrationsFolder?: string;
}

/** Applies pending migrations with a dedicated single connection. */
export async function runMigrations(databaseUrl: string, options: MigrationOptions = {}): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: options.migrationsFolder ?? migrationsFolder });
  } finally {
    await client.end();
  }
}
