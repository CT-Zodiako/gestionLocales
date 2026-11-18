import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { schema, type Database } from "@gestion/db";

export type AuthOptions = {
  database: Database;
  /** BETTER_AUTH_SECRET: signs session cookies and password hashes. */
  secret: string;
  /** BETTER_AUTH_URL: public origin the browser uses to reach /api/auth. */
  baseURL: string;
};

function buildAuth(options: AuthOptions, settings: { publicSignUp: boolean }) {
  return betterAuth({
    secret: options.secret,
    baseURL: options.baseURL,
    database: drizzleAdapter(options.database, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      /** Only the owner exists in stage 2; it is created by `pnpm auth:create-user`. */
      disableSignUp: !settings.publicSignUp,
      autoSignIn: false,
    },
  });
}

/**
 * Auth instance mounted in Hono: email+password sign-in, public sign-up off.
 */
export function createAuth(options: AuthOptions) {
  return buildAuth(options, { publicSignUp: false });
}

/**
 * Auth instance for the owner CLI. It enables the sign-up endpoint so the CLI
 * can create the single owner through Better Auth's own hashing and account
 * linking instead of writing password hashes by hand. It is never mounted.
 */
export function createProvisioningAuth(options: AuthOptions) {
  return buildAuth(options, { publicSignUp: true });
}

export type Auth = ReturnType<typeof createAuth>;
export type ProvisioningAuth = ReturnType<typeof createProvisioningAuth>;
