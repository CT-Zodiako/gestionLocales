/** Dev-only fallback; production refuses to start without BETTER_AUTH_SECRET. */
export const DEV_AUTH_SECRET = "dev-only-better-auth-secret-change-me-0123456789";

export type ApiEnv = {
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
  port: number;
  runMigrations: boolean;
};

/** Reads and validates the API environment, throwing a readable message. */
export function readApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const port = Number(source.PORT ?? 3000);
  const isProduction = source.NODE_ENV === "production";
  const authSecret = source.BETTER_AUTH_SECRET || (isProduction ? "" : DEV_AUTH_SECRET);
  if (!authSecret) throw new Error("BETTER_AUTH_SECRET is required when NODE_ENV=production");

  return {
    databaseUrl,
    authSecret,
    authUrl: source.BETTER_AUTH_URL || `http://localhost:${port}`,
    port,
    runMigrations: source.RUN_MIGRATIONS === "true",
  };
}
