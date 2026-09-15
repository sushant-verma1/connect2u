import { createPgClient } from "@otp-router/db/client";
import { insertAccount } from "@otp-router/db/repositories/accounts";
import { insertApiKey } from "@otp-router/db/repositories/api-keys";
import { ulid } from "ulid";
import { generateApiKey, hashApiKey } from "../crypto/api-key.js";
import { hashPassword } from "../crypto/password.js";
import { loadConfig } from "../config.js";

/** R11.5/R13.6: produces a working local account, reachable both ways — the dashboard
 * (email + password) and the API (the printed key). Run with
 * `pnpm --filter @otp-router/api seed`. */
const config = loadConfig();
const pg = createPgClient(config.databaseUrl);

const DEV_EMAIL = "dev@localhost";
const DEV_PASSWORD = "dev-password";

const passwordHash = await hashPassword(DEV_PASSWORD, config.passwordPepper);

const account = await insertAccount(pg, {
  id: `acct_${ulid()}`,
  name: "Local dev account",
  email: DEV_EMAIL,
  passwordHash,
  status: "active",
});

const { fullKey, prefix } = generateApiKey("test");
const keyHash = await hashApiKey(fullKey, config.apiKeyPepper);
await insertApiKey(pg, {
  id: `key_${ulid()}`,
  accountId: account.id,
  keyHash,
  keyPrefix: prefix,
});

await pg.end();

console.log(`Seeded account ${account.id}`);
console.log(`Dashboard login — email: ${DEV_EMAIL}  password: ${DEV_PASSWORD}`);
console.log(`API key (shown once — store it now): ${fullKey}`);
