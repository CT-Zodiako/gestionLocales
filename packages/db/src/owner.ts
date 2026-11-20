import { and, eq, notExists } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  appointmentReminders,
  appointments,
  businesses,
  customers,
  openingHours,
  services,
  users,
  whatsappChannels,
  whatsappPendingNames,
  whatsappProcessedMessages,
} from "./schema.ts";

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

/** Reuses the business with that name or creates it; `created` tells which. */
export async function ensureBusiness(db: Database, name: string): Promise<{ id: string; created: boolean }> {
  const existing = await findBusinessByName(db, name);
  if (existing) return { id: existing.id, created: false };

  const inserted = await db.insert(businesses).values({ name }).returning({ id: businesses.id });
  const created = inserted[0];
  if (!created) throw new Error(`Could not create business: ${name}`);
  return { id: created.id, created: true };
}

/** Deletes the business only when no user or agenda table references it; used to undo a half-done provisioning. */
export async function removeBusinessIfUnreferenced(db: Database, businessId: string): Promise<void> {
  await db.delete(businesses).where(
    and(
      eq(businesses.id, businessId),
      notExists(db.select({ id: users.id }).from(users).where(eq(users.businessId, businessId))),
      notExists(db.select({ id: customers.id }).from(customers).where(eq(customers.businessId, businessId))),
      notExists(db.select({ id: services.id }).from(services).where(eq(services.businessId, businessId))),
      notExists(db.select({ id: openingHours.id }).from(openingHours).where(eq(openingHours.businessId, businessId))),
      notExists(db.select({ id: appointments.id }).from(appointments).where(eq(appointments.businessId, businessId))),
      notExists(
        db
          .select({ id: appointmentReminders.id })
          .from(appointmentReminders)
          .where(eq(appointmentReminders.businessId, businessId)),
      ),
      notExists(db.select({ id: whatsappChannels.id }).from(whatsappChannels).where(eq(whatsappChannels.businessId, businessId))),
      notExists(
        db
          .select({ phone: whatsappPendingNames.phone })
          .from(whatsappPendingNames)
          .where(eq(whatsappPendingNames.businessId, businessId)),
      ),
      notExists(
        db
          .select({ wamid: whatsappProcessedMessages.wamid })
          .from(whatsappProcessedMessages)
          .where(eq(whatsappProcessedMessages.businessId, businessId)),
      ),
    ),
  );
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
