import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value).digest("hex");
}

/** R1.2.1 / R2.2: constant-time compare, never string equality. */
export function hmacMatches(value: string, pepper: string, storedHex: string): boolean {
  const computed = Buffer.from(hmacHex(value, pepper), "hex");
  const stored = Buffer.from(storedHex, "hex");
  if (computed.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(computed, stored);
}
