import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { createPgClient, type PgClient } from "@otp-router/db/client";
import { runMigrations } from "@otp-router/db/migrate";
import { insertAccount } from "@otp-router/db/repositories/accounts";
import { insertApiKey } from "@otp-router/db/repositories/api-keys";
import { Redis } from "ioredis";
import { ulid } from "ulid";
import { generateApiKey, hashApiKey } from "../../src/crypto/api-key.js";

export type Infra = Readonly<{
  pg: PgClient;
  redis: Redis;
  databaseUrl: string;
  redisUrl: string;
  stop: () => Promise<void>;
}>;

/** AGENTS.md §5: real Postgres and Redis via Testcontainers — never mocked. */
export async function startInfra(): Promise<Infra> {
  const [pgContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer("postgres:16").start(),
    new RedisContainer("redis:7").start(),
  ]).catch((err) => {
    // Testcontainers fails this way when Docker isn't running at all. Left as its
    // original error, this looks like an ordinary test failure and a skipped
    // acceptance gate (T1–T11) can be mistaken for a passed one. Fail loudly instead.
    if (err instanceof Error && /container runtime/i.test(err.message)) {
      throw new Error(
        "Docker must be running to execute the integration suite — T1–T11 did not execute.\n" +
          `Underlying error: ${err.message}`,
      );
    }
    throw err;
  });

  const databaseUrl = pgContainer.getConnectionUri();
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const pg = createPgClient(databaseUrl);
  await runMigrations(pg);
  const redis = new Redis(redisUrl);

  return {
    pg,
    redis,
    databaseUrl,
    redisUrl,
    stop: async () => {
      redis.disconnect();
      await pg.end();
      await Promise.all([pgContainer.stop(), redisContainer.stop()]);
    },
  };
}

/**
 * Phase 7's rate limits and fraud signals (rate-limit.ts, fraud-signals.ts) live in
 * Redis, not Postgres, and carry real TTLs that outlive a single test — without this,
 * every test file that calls `/start` against the same handful of synthetic phone
 * numbers across several `it` blocks (most of them do) can spuriously trip a *later*
 * test's rate limit with counters a completely unrelated *earlier* test left behind.
 */
export async function truncateAll(pg: PgClient, redis: Redis): Promise<void> {
  await Promise.all([
    pg`TRUNCATE TABLE
      webhook_events, delivery_attempts, verifications, api_keys, accounts,
      routing_policies, channel_capability, channel_scores, routing_decisions, provider_rates
      CASCADE`,
    redis.flushdb(),
  ]);
}

/**
 * R13.1/R13.2: shared across every integration suite that needs an authenticated
 * account — was seven near-identical copies (one per test file) before the
 * `api_keys` split, each constructing the account row and its key by hand. One
 * definition now, so a future schema change to either table is a one-file fix.
 */
export async function seedAccount(
  pg: PgClient,
  apiKeyPepper: string,
  name: string,
  overrides: { dailyCostCapMicros?: number } = {},
): Promise<{ accountId: string; apiKey: string }> {
  const { fullKey, prefix } = generateApiKey("test");
  const keyHash = await hashApiKey(fullKey, apiKeyPepper);
  const account = await insertAccount(pg, {
    id: `acct_${ulid()}`,
    name,
    email: `${prefix}@test.invalid`,
    status: "active",
    ...(overrides.dailyCostCapMicros !== undefined
      ? { dailyCostCapMicros: overrides.dailyCostCapMicros }
      : {}),
  });
  await insertApiKey(pg, {
    id: `key_${ulid()}`,
    accountId: account.id,
    keyHash,
    keyPrefix: prefix,
  });
  return { accountId: account.id, apiKey: fullKey };
}
