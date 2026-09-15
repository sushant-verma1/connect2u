import { randomInt } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * R7.1: a sliding-window log, not a fixed bucket — a fixed window lets 2x the limit
 * through across a boundary (a burst at 0:59 and another at 1:00 both pass). One
 * sorted set per key: each request is a member scored by its own timestamp; ZREMRANGEBYSCORE
 * evicts everything older than the window, ZCARD counts what's left, and the whole
 * thing runs as one Lua script so check-and-record is atomic — two concurrent
 * requests can't both read "under limit" and both get admitted.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, "-inf", now - windowMs)
local count = redis.call("ZCARD", key)

if count >= limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retryAfterMs = windowMs
  if oldest[2] ~= nil then
    retryAfterMs = windowMs - (now - tonumber(oldest[2]))
  end
  return {0, retryAfterMs}
end

redis.call("ZADD", key, now, member)
redis.call("PEXPIRE", key, windowMs)
return {1, 0}
`;

export type RateLimitResult = Readonly<{ allowed: boolean; retryAfterMs: number }>;

/** R7.1: one ceiling. Called three times per /start — number, account, IP — each with
 * its own key and its own limit, never sharing a counter. */
export async function checkSlidingWindow(
  redis: Redis,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const [result] = await checkSlidingWindows(redis, [{ key, limit, windowMs }]);
  if (!result) throw new Error("checkSlidingWindows returned no result for one input");
  return result;
}

export type SlidingWindowSpec = Readonly<{ key: string; limit: number; windowMs: number }>;

/**
 * R1.1.5/R7.1: every ceiling this request is checked against evaluated in one
 * pipelined round trip to Redis, not one round trip per key — a Lua eval per key,
 * awaited one at a time (even "concurrently" via `Promise.all` on a single ioredis
 * connection), still measured enough latency in a containerised test Redis to matter
 * against /start's 100ms budget. `pipeline()` writes every command before reading any
 * response back, so N checks cost close to one network round trip, not N.
 */
export async function checkSlidingWindows(
  redis: Redis,
  specs: readonly SlidingWindowSpec[],
): Promise<RateLimitResult[]> {
  if (specs.length === 0) return [];
  const now = Date.now();
  const pipeline = redis.pipeline();
  for (const { key, limit, windowMs } of specs) {
    // A random member (not just `now`) so two requests landing in the same
    // millisecond don't collide as the same sorted-set member and get silently
    // deduped to one. I6: crypto.randomInt, never Math.random.
    const member = `${now}:${randomInt(0, 1_000_000_000)}`;
    pipeline.eval(SLIDING_WINDOW_SCRIPT, 1, key, now, windowMs, limit, member);
  }
  const results = await pipeline.exec();
  if (!results) throw new Error("Redis pipeline returned null — connection closed?");

  return results.map(([err, raw]) => {
    if (err) throw err;
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error(`unexpected sliding-window script result: ${JSON.stringify(raw)}`);
    }
    const [allowed, retryAfterMs] = raw;
    if (typeof allowed !== "number" || typeof retryAfterMs !== "number") {
      throw new Error(`unexpected sliding-window script result: ${JSON.stringify(raw)}`);
    }
    return { allowed: allowed === 1, retryAfterMs };
  });
}

// R7.1: placeholder ceilings — there's no production traffic yet to tune these
// against. Per-number is the tightest (a real user starts a verification rarely; a
// script hammering one number is the classic brute-force/enumeration shape). Per-IP
// sits above per-account to allow for NATed office/mobile-carrier IPs shared by many
// legitimate accounts. Ceiling: revisit once real traffic gives these numbers a basis.
export const RATE_LIMITS = {
  perNumber: { limit: 5, windowMs: 10 * 60 * 1000 }, // 5 / 10 min
  perAccount: { limit: 100, windowMs: 60 * 1000 }, // 100 / min
  perIp: { limit: 20, windowMs: 60 * 1000 }, // 20 / min
} as const;

export type RateLimitBreach = Readonly<{
  scope: "number" | "account" | "ip";
  retryAfterMs: number;
}>;

/**
 * R1.1.5/R1.1.7: all three ceilings are independent — different keys, no data
 * dependency — so they run concurrently, not as three sequential round trips against
 * Redis. /start has a 100ms budget regardless of provider latency (R1.1.5); three
 * awaited-in-series Lua evals against a containerised Redis in tests alone measured
 * enough added latency to blow that budget, for no correctness benefit over running
 * them together and picking a winner. First breach in priority order (number, account,
 * IP — narrowest scope first, since that's the one most likely to explain *why*) is
 * returned if more than one ceiling was crossed by the same request. A checked-and-
 * passed ceiling still recorded this request even when a *different* ceiling rejects
 * it — deliberately not rolled back, same reasoning as the sequential version this
 * replaced: the rejected request was still a real attempt against that
 * number/account/IP.
 */
export async function checkStartRateLimits(
  redis: Redis,
  params: { phoneHash: string; accountId: string; ip: string },
): Promise<RateLimitBreach | null> {
  const scopes: readonly RateLimitBreach["scope"][] = ["number", "account", "ip"];
  const specs: readonly SlidingWindowSpec[] = [
    {
      key: `rl:number:${params.phoneHash}`,
      limit: RATE_LIMITS.perNumber.limit,
      windowMs: RATE_LIMITS.perNumber.windowMs,
    },
    {
      key: `rl:account:${params.accountId}`,
      limit: RATE_LIMITS.perAccount.limit,
      windowMs: RATE_LIMITS.perAccount.windowMs,
    },
    {
      key: `rl:ip:${params.ip}`,
      limit: RATE_LIMITS.perIp.limit,
      windowMs: RATE_LIMITS.perIp.windowMs,
    },
  ];

  const results = await checkSlidingWindows(redis, specs);

  for (let i = 0; i < scopes.length; i++) {
    const result = results[i];
    const scope = scopes[i];
    if (scope && result && !result.allowed) {
      return { scope, retryAfterMs: result.retryAfterMs };
    }
  }
  return null;
}

// R13.6: login is the credential-stuffing surface — per-email is the tight ceiling (a
// real user logs in rarely enough that 5/15min is generous; a script trying passwords
// against one address is exactly this shape). Per-IP sits above it for the same
// NAT/shared-IP reason as RATE_LIMITS.perIp. Placeholder ceilings, same as RATE_LIMITS —
// no production traffic yet to tune against.
export const LOGIN_RATE_LIMITS = {
  perEmail: { limit: 5, windowMs: 15 * 60 * 1000 }, // 5 / 15 min
  perIp: { limit: 20, windowMs: 15 * 60 * 1000 }, // 20 / 15 min
} as const;

export type LoginRateLimitBreach = Readonly<{
  scope: "email" | "ip";
  retryAfterMs: number;
}>;

/** R13.6: `emailHash` — never the plaintext address — as the Redis key, same reasoning
 * as phone_hash elsewhere: this key doesn't need to be reversible, just stable. */
export async function checkLoginRateLimits(
  redis: Redis,
  params: { emailHash: string; ip: string },
): Promise<LoginRateLimitBreach | null> {
  const scopes: readonly LoginRateLimitBreach["scope"][] = ["email", "ip"];
  const specs: readonly SlidingWindowSpec[] = [
    {
      key: `rl:login-email:${params.emailHash}`,
      limit: LOGIN_RATE_LIMITS.perEmail.limit,
      windowMs: LOGIN_RATE_LIMITS.perEmail.windowMs,
    },
    {
      key: `rl:login-ip:${params.ip}`,
      limit: LOGIN_RATE_LIMITS.perIp.limit,
      windowMs: LOGIN_RATE_LIMITS.perIp.windowMs,
    },
  ];

  const results = await checkSlidingWindows(redis, specs);

  for (let i = 0; i < scopes.length; i++) {
    const result = results[i];
    const scope = scopes[i];
    if (scope && result && !result.allowed) {
      return { scope, retryAfterMs: result.retryAfterMs };
    }
  }
  return null;
}
