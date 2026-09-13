import { MetaProvider } from "@otp-router/providers/meta";
import { loadConfig } from "../config.js";

/**
 * Phase 4 exit gate: proves `MetaProvider` talks to the real Cloud API, not just its
 * documented shape. `hello_world` is the one template every WABA has by default —
 * authentication templates are unavailable on a test WABA (PROJECT.md's hard
 * constraint), so this is the live proof, not the production sending path.
 *
 * Run with `pnpm --filter @otp-router/api send:hello-world -- +91XXXXXXXXXX` and record
 * the result for the demo.
 */
const recipient = process.argv[2];
if (!recipient) {
  console.error("Usage: send:hello-world -- <E.164 phone number>");
  process.exit(1);
}

const config = loadConfig();
if (!config.metaPhoneNumberId || !config.metaAccessToken || !config.metaAppSecret) {
  console.error("META_PHONE_NUMBER_ID, META_ACCESS_TOKEN, and META_APP_SECRET must all be set");
  process.exit(1);
}

const provider = new MetaProvider({
  phoneNumberId: config.metaPhoneNumberId,
  accessToken: config.metaAccessToken,
  appSecret: config.metaAppSecret,
  templateName: "hello_world",
});

const result = await provider.send({ phoneNumber: recipient, code: "000000", channel: "whatsapp" });
console.log(`Sent — provider_message_id: ${result.providerMessageId}`);
