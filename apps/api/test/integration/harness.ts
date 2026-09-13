import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { createPgClient, type PgClient } from "@otp-router/db/client";
import { runMigrations } from "@otp-router/db/migrate";
import { Redis } from "ioredis";

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

export async function truncateAll(pg: PgClient): Promise<void> {
  await pg`TRUNCATE TABLE webhook_events, delivery_attempts, verifications, accounts CASCADE`;
}
