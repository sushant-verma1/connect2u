import { createPgClient } from "@otp-router/db/client";
import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const pg = createPgClient(config.databaseUrl);
const redis = new Redis(config.redisUrl, { lazyConnect: true });
// BullMQ requires its own connection with maxRetriesPerRequest: null — kept separate
// from the general-purpose `redis` client used for the /ready check. No `lazyConnect`:
// bullmq drives this connection's lifecycle itself as soon as a Queue is constructed.
const bullConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const app = await buildApp(config, pg, redis, bullConnection);

await redis.connect();

try {
  // Railway's private network is IPv6-only (api.railway.internal is AAAA-only), and
  // 0.0.0.0 binds the IPv4 stack alone — the dashboard's nginx would connect to an
  // address nothing is listening on. "::" is dual-stack (Node leaves ipv6Only off),
  // so docker-compose and IPv4 health checks keep working.
  await app.listen({ port: config.port, host: "::" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

async function shutdown(): Promise<void> {
  await app.close();
  await pg.end();
  redis.disconnect();
  bullConnection.disconnect();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
