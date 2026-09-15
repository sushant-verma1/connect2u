import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import type { Account } from "./accounts.js";
import { accounts, apiKeys } from "../schema.js";

export type ApiKey = typeof apiKeys.$inferSelect;

export type AccountWithApiKey = Readonly<{ account: Account; apiKey: ApiKey }>;

/**
 * R13.2/R7.4: the auth hook's only lookup — joined so a valid, unrevoked key resolves
 * straight to the account it authenticates. A revoked key (`revoked_at` set) simply
 * doesn't match, same as a wrong prefix: the caller gets `null` either way and reports
 * a plain 401, never distinguishing "revoked" from "never existed".
 */
export async function findAccountByApiKeyPrefix(
  client: PgClient,
  keyPrefix: string,
): Promise<AccountWithApiKey | null> {
  const db = drizzle(client);
  const rows = await db
    .select({ account: accounts, apiKey: apiKeys })
    .from(apiKeys)
    .innerJoin(accounts, eq(apiKeys.accountId, accounts.id))
    .where(and(eq(apiKeys.keyPrefix, keyPrefix), isNull(apiKeys.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** R13.3: listed newest-first; revoked keys are excluded, not shown as "revoked" rows —
 * DELETE removes them from this list, it doesn't just flag them. */
export async function listApiKeys(client: PgClient, accountId: string): Promise<ApiKey[]> {
  const db = drizzle(client);
  return db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
}

export async function insertApiKey(
  client: PgClient,
  key: typeof apiKeys.$inferInsert,
): Promise<ApiKey> {
  const db = drizzle(client);
  const rows = await db.insert(apiKeys).values(key).returning();
  const inserted = rows[0];
  if (!inserted) {
    throw new Error("api key insert returned no row");
  }
  return inserted;
}

/**
 * I2: single conditional UPDATE, not read-then-write. Scoped to `accountId` too — this
 * is what stops one account from revoking another's key by guessing an id. Zero rows
 * affected (already revoked, or not this account's key) returns `null`; the route
 * reports 404 either way rather than leaking which case it was.
 */
export async function revokeApiKey(
  client: PgClient,
  id: string,
  accountId: string,
): Promise<ApiKey | null> {
  const db = drizzle(client);
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)))
    .returning();
  return rows[0] ?? null;
}

/** Written only on an auth-cache miss (api-key-auth.ts) — accurate to within
 * `AUTH_CACHE_TTL_MS`, one write per key per cache period instead of one per request. */
export async function touchApiKeyLastUsed(client: PgClient, id: string): Promise<void> {
  const db = drizzle(client);
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}
