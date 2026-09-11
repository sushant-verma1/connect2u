import { createPgClient } from "@otp-router/db/client";
import { insertAccount } from "@otp-router/db/repositories/accounts";
import { generateApiKey, hashApiKey } from "../crypto/api-key.js";
import { loadConfig } from "../config.js";

/** R11.5: produces a working local account. Run with `pnpm --filter @otp-router/api seed`. */
const config = loadConfig();
const pg = createPgClient(config.databaseUrl);

const { fullKey, prefix } = generateApiKey("test");
const apiKeyHash = await hashApiKey(fullKey, config.apiKeyPepper);

const account = await insertAccount(pg, {
  id: `acct_${prefix}`,
  name: "Local dev account",
  apiKeyHash,
  apiKeyPrefix: prefix,
  status: "active",
});

await pg.end();

console.log(`Seeded account ${account.id}`);
console.log(`API key (shown once — store it now): ${fullKey}`);
