import { parsePhoneNumberFromString } from "libphonenumber-js";
import { hmacHex } from "./hmac.js";

/** R1.1.1: normalise to E.164, or null if the number isn't valid. */
export function normalizePhoneNumber(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw);
  if (!parsed || !parsed.isValid()) {
    return null;
  }
  return parsed.number;
}

export function hashPhone(e164: string, pepper: string): string {
  return hmacHex(e164, pepper);
}
