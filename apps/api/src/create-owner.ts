import {
  createDb,
  ensureBusiness,
  findUserByEmail,
  linkUserToBusiness,
  removeBusinessIfUnreferenced,
  type Database,
} from "@gestion/db";
import { createProvisioningAuth, type ProvisioningAuth } from "./auth.ts";

export type CreateOwnerInput = {
  db: Database;
  auth: ProvisioningAuth;
  email: string;
  password: string;
  name: string;
  businessName: string;
};

export type CreateOwnerResult =
  | { status: "created"; userId: string; businessId: string }
  | { status: "linked"; userId: string; businessId: string }
  | { status: "exists"; userId: string; businessId: string | null };

export type ProvisionOwnerOptions = {
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
} & Omit<CreateOwnerInput, "db" | "auth">;

/**
 * Creates the single owner: ensures the business row exists and links the new
 * user to it through `business_id`. Idempotent on email: a second call reports
 * the existing user and writes nothing. An existing user without a business (left by a partial
 * run) is linked to the business and reported as "linked".
 *
 * The user and its credential account are created by Better Auth's sign-up API,
 * so hashing and account linking stay inside Better Auth.
 */
export async function createOwner(input: CreateOwnerInput): Promise<CreateOwnerResult> {
  const email = input.email.trim().toLowerCase();

  const existing = await findUserByEmail(input.db, email);
  if (existing?.businessId) {
    return { status: "exists", userId: existing.id, businessId: existing.businessId };
  }

  const business = await ensureBusiness(input.db, input.businessName);

  if (existing) {
    await linkUserToBusiness(input.db, existing.id, business.id);
    return { status: "linked", userId: existing.id, businessId: business.id };
  }

  let created: Awaited<ReturnType<ProvisioningAuth["api"]["signUpEmail"]>>;
  try {
    created = await input.auth.api.signUpEmail({
      body: { email, password: input.password, name: input.name },
    });
  } catch (error) {
    // Do not leave behind a business this call created for a user that never existed.
    if (business.created) {
      await removeBusinessIfUnreferenced(input.db, business.id).catch(() => undefined);
    }
    throw error;
  }
  await linkUserToBusiness(input.db, created.user.id, business.id);

  return { status: "created", userId: created.user.id, businessId: business.id };
}

/** One-shot variant that opens and closes its own database connection. */
export async function provisionOwner(options: ProvisionOwnerOptions): Promise<CreateOwnerResult> {
  const database = createDb(options.databaseUrl);
  try {
    const auth = createProvisioningAuth({
      database: database.db,
      secret: options.authSecret,
      baseURL: options.authUrl,
    });
    return await createOwner({
      db: database.db,
      auth,
      email: options.email,
      password: options.password,
      name: options.name,
      businessName: options.businessName,
    });
  } finally {
    await database.close();
  }
}
