import { eq } from "drizzle-orm";
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
