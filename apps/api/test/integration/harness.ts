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
  ]);

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
  await pg`TRUNCATE TABLE delivery_attempts, verifications, accounts CASCADE`;
}
