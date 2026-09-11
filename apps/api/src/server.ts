import { createPgClient } from "@otp-router/db";
import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const pg = createPgClient(config.databaseUrl);
const redis = new Redis(config.redisUrl, { lazyConnect: true });

const app = await buildApp(config, pg, redis);

await redis.connect();

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

async function shutdown(): Promise<void> {
  await app.close();
  await pg.end();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
