import { createPgClient } from "./client.js";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run migrations");
}

const client = createPgClient(databaseUrl);
await runMigrations(client);
await client.end();
console.log("migrations applied");
