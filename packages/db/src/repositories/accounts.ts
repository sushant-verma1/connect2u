import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import { accounts } from "../schema.js";

export type Account = typeof accounts.$inferSelect;

export async function findAccountByApiKeyPrefix(
  client: PgClient,
  apiKeyPrefix: string,
): Promise<Account | null> {
  const db = drizzle(client);
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.apiKeyPrefix, apiKeyPrefix))
    .limit(1);
  return rows[0] ?? null;
}

export async function findAccountById(client: PgClient, id: string): Promise<Account | null> {
  const db = drizzle(client);
  const rows = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertAccount(
  client: PgClient,
  account: typeof accounts.$inferInsert,
): Promise<Account> {
  const db = drizzle(client);
  const rows = await db.insert(accounts).values(account).returning();
  const inserted = rows[0];
  if (!inserted) {
    throw new Error("account insert returned no row");
  }
  return inserted;
}

/**
 * R7.5/R7.6: atomic conditional UPDATE, same shape as every other state transition in
 * this codebase — only trips an `active` account, so this never overwrites an
 * already-`suspended` account back down to a less-severe status, and calling it twice
 * concurrently is safe (the second caller's WHERE matches zero rows).
 */
export async function tripAccountToManualReview(
  client: PgClient,
  accountId: string,
): Promise<Account | null> {
  const db = drizzle(client);
  const rows = await db
    .update(accounts)
    .set({ status: "manual_review" })
    .where(and(eq(accounts.id, accountId), eq(accounts.status, "active")))
    .returning();
  return rows[0] ?? null;
}
