import { runMigrations } from "@gestion/db";
import { databaseUrl } from "./support/env.ts";

/** Applies pending migrations once, before any test file runs. */
export default async function setup(): Promise<void> {
  await runMigrations(databaseUrl);
}
