import { randomInt } from "node:crypto";

/** R2.1: crypto.randomInt only — Math.random is forbidden (I6). */
export function generateCode(length: number): string {
  const max = 10 ** length;
  const value = randomInt(0, max);
  return value.toString().padStart(length, "0");
}
