import argon2 from "argon2";

/** R13.6: same primitive as API keys (R7.4, argon2 — never for OTP codes), a distinct
 * pepper (PASSWORD_PEPPER, AGENTS.md §11: peppers are never shared between purposes). */
export async function hashPassword(password: string, pepper: string): Promise<string> {
  return argon2.hash(password + pepper);
}

export async function verifyPassword(
  password: string,
  pepper: string,
  storedHash: string,
): Promise<boolean> {
  return argon2.verify(storedHash, password + pepper);
}
