import { eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { businesses, users } from "./schema.ts";

export type OwnerRef = {
  id: string;
  businessId: string | null;
};

/** The signed-in owner together with the business it belongs to. */
export type OwnerWithBusiness = {
  user: { id: string; email: string; name: string };
  business: { id: string; name: string };
};

export async function findUserByEmail(db: Database, email: string): Promise<OwnerRef | null> {
  const rows = await db
    .select({ id: users.id, businessId: users.businessId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return rows[0] ?? null;
}

export async function findBusinessByName(db: Database, name: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.name, name))
    .limit(1);
  return rows[0] ?? null;
}

/** Reuses the business with that name or creates it. */
export async function ensureBusiness(db: Database, name: string): Promise<{ id: string }> {
  const existing = await findBusinessByName(db, name);
  if (existing) return existing;

  const inserted = await db.insert(businesses).values({ name }).returning({ id: businesses.id });
  const created = inserted[0];
  if (!created) throw new Error(`Could not create business: ${name}`);
  return created;
}

export async function linkUserToBusiness(db: Database, userId: string, businessId: string): Promise<void> {
  await db.update(users).set({ businessId }).where(eq(users.id, userId));
}

/** Loads the owner and its business joined through user.business_id. */
export async function findOwnerWithBusiness(db: Database, userId: string): Promise<OwnerWithBusiness | null> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      businessId: businesses.id,
      businessName: businesses.name,
    })
    .from(users)
    .innerJoin(businesses, eq(users.businessId, businesses.id))
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    user: { id: row.userId, email: row.email, name: row.name },
    business: { id: row.businessId, name: row.businessName },
  };
}

/** Removes the owner; its sessions and accounts go with it (ON DELETE CASCADE). */
export async function removeUserByEmail(db: Database, email: string): Promise<void> {
  await db.delete(users).where(eq(users.email, email));
}

export async function removeBusinessByName(db: Database, name: string): Promise<void> {
  await db.delete(businesses).where(eq(businesses.name, name));
}
