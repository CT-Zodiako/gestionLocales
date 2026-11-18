import { randomUUID } from "node:crypto";

/** Test database: the compose Postgres unless DATABASE_URL points elsewhere. */
export const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://gestion:gestion@localhost:5433/gestion";

/** Origin the API trusts during tests (matches BETTER_AUTH_URL). */
export const authUrl = "http://localhost:3000";

/** Long enough for Better Auth's production secret check. */
export const authSecret = "test-only-better-auth-secret-0123456789";

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.com`;
}
