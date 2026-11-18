import { provisionOwner } from "./create-owner.ts";

const USAGE = `Creates the single business owner.

Usage:
  pnpm auth:create-user --email <email> --password <password> --name <name> --business "<business name>"

Every option falls back to an env var, so this works too:
  AUTH_EMAIL=... AUTH_PASSWORD=... AUTH_NAME=... BUSINESS_NAME=... pnpm auth:create-user

It is idempotent on email: a re-run reports the existing user and writes nothing.

Required env vars (same as the API): DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL.`;

export type OwnerInput = {
  email: string;
  password: string;
  name: string;
  businessName: string;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Reads `--name value` pairs; flags without a value are stored as "". */
function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || !arg.startsWith("--")) continue;

    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values[arg.slice(2)] = "";
      continue;
    }

    values[arg.slice(2)] = next;
    index += 1;
  }
  return values;
}

function requireValue(label: string, value: string | undefined): string {
  if (!value) fail(`Missing value: ${label}\n\n${USAGE}`);
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`Missing environment variable: ${name}`);
  return value;
}

function readOwner(args: Record<string, string>): OwnerInput {
  return {
    email: requireValue("--email (AUTH_EMAIL)", args.email || process.env.AUTH_EMAIL),
    password: requireValue("--password (AUTH_PASSWORD)", args.password || process.env.AUTH_PASSWORD),
    name: requireValue("--name (AUTH_NAME)", args.name || process.env.AUTH_NAME),
    businessName: requireValue("--business (BUSINESS_NAME)", args.business || process.env.BUSINESS_NAME),
  };
}

const args = parseArgs(process.argv.slice(2));
if ("help" in args || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const owner = readOwner(args);
const result = await provisionOwner({
  ...owner,
  databaseUrl: requireEnv("DATABASE_URL"),
  authSecret: requireEnv("BETTER_AUTH_SECRET"),
  authUrl: requireEnv("BETTER_AUTH_URL"),
});

if (result.status === "exists") {
  console.log(`User already exists: ${owner.email}`);
  console.log(`Business id: ${result.businessId ?? "(not linked)"}`);
} else {
  console.log(`Owner created: ${owner.email}`);
  console.log(`Business id: ${result.businessId}`);
}
