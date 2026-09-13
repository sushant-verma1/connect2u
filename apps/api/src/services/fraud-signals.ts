import type { Redis } from "ioredis";
import type { PgClient } from "@otp-router/db/client";
import { tripAccountToManualReview } from "@otp-router/db/repositories/accounts";
import { checkSlidingWindow } from "./rate-limit.js";

// Structural, not `pino.Logger` or Fastify's `FastifyBaseLogger` — both shapes
// satisfy this, and neither is structurally assignable to the *other* (Fastify's
// request.log is missing pino's `msgPrefix`), so a concrete import would force every
// caller onto one specific logger implementation for no reason these functions need.
type FraudLogger = { warn(obj: Record<string, unknown>, msg: string): void };

// R7.6: the numbering-block size a velocity spike is measured over — enumeration and
// toll-fraud both look like many *different* numbers hit fast within one narrow block,
// which a per-number rate limit (rate-limit.ts) can't see since each number alone
// stays under its own ceiling. First 6 E.164 characters (country code + a few
// significant digits) is a placeholder granularity — revisit once real traffic shows
// what block size toll-fraud actually clusters in.
const PREFIX_LENGTH = 6;
const PREFIX_VELOCITY_LIMIT = 30;
const PREFIX_VELOCITY_WINDOW_MS = 60 * 1000;

export function numberPrefix(e164PhoneNumber: string): string {
  return e164PhoneNumber.slice(0, PREFIX_LENGTH);
}

/**
 * R7.6: unlike per-number/account/IP rate limits (which throttle and let the caller
 * retry later), a prefix velocity breach is a fraud signal about the *account* making
 * the requests, not the number being targeted — so it trips the same
 * `tripAccountToManualReview` the daily-spend ceiling uses (R7.5), halting every
 * subsequent send from this account, not just this one request. Returns `true` when
 * the request that triggered the breach should itself be rejected too.
 */
export async function checkPrefixVelocity(
  redis: Redis,
  pg: PgClient,
  params: { accountId: string; phoneNumber: string },
  logger: FraudLogger,
): Promise<boolean> {
  const prefix = numberPrefix(params.phoneNumber);
  const { allowed } = await checkSlidingWindow(
    redis,
    `fraud:prefix:${prefix}`,
    PREFIX_VELOCITY_LIMIT,
    PREFIX_VELOCITY_WINDOW_MS,
  );
  if (allowed) return false;

  const tripped = await tripAccountToManualReview(pg, params.accountId);
  logger.warn(
    {
      accountId: params.accountId,
      prefix,
      limit: PREFIX_VELOCITY_LIMIT,
      windowMs: PREFIX_VELOCITY_WINDOW_MS,
      trippedToManualReview: tripped !== null,
    },
    "R7.6 prefix velocity limit exceeded — likely enumeration or toll fraud",
  );
  return true;
}

// R7.7: two windows per account — a short "right now" window and a longer baseline —
// so "shift" means something (a account that's always 50/50 domestic/international
// isn't shifting; one that jumps from 95% domestic to 60% international is). Counter
// TTLs approximate the windows rather than a true sliding log — precision doesn't
// matter for an alert the way it does for the hard rate-limit ceiling above.
const SHORT_WINDOW_SECONDS = 60 * 60; // 1 hour
const BASELINE_WINDOW_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MIN_SAMPLE_SIZE = 20;
const SHIFT_THRESHOLD = 0.25; // 25 percentage points

async function incrementWithTtl(redis: Redis, key: string, ttlSeconds: number): Promise<number> {
  const value = await redis.incr(key);
  if (value === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return value;
}

/** R7.7: alert-only, deliberately — a real shift to a new country mix can be a
 * legitimate new market, not fraud, so this never blocks a request, only logs. */
export async function recordAndCheckCountryMix(
  redis: Redis,
  accountId: string,
  country: "IN" | "INTL",
  logger: FraudLogger,
): Promise<void> {
  const isIntl = country === "INTL" ? 1 : 0;

  const [shortTotal, shortIntl, baselineTotal, baselineIntl] = await Promise.all([
    incrementWithTtl(redis, `fraud:country:short:total:${accountId}`, SHORT_WINDOW_SECONDS),
    isIntl
      ? incrementWithTtl(redis, `fraud:country:short:intl:${accountId}`, SHORT_WINDOW_SECONDS)
      : Number(await redis.get(`fraud:country:short:intl:${accountId}`)) || 0,
    incrementWithTtl(redis, `fraud:country:baseline:total:${accountId}`, BASELINE_WINDOW_SECONDS),
    isIntl
      ? incrementWithTtl(redis, `fraud:country:baseline:intl:${accountId}`, BASELINE_WINDOW_SECONDS)
      : Number(await redis.get(`fraud:country:baseline:intl:${accountId}`)) || 0,
  ]);

  if (shortTotal < MIN_SAMPLE_SIZE || baselineTotal < MIN_SAMPLE_SIZE) return;

  const shortShare = shortIntl / shortTotal;
  const baselineShare = baselineIntl / baselineTotal;

  if (shortShare - baselineShare > SHIFT_THRESHOLD) {
    logger.warn(
      { accountId, shortShare, baselineShare },
      "R7.7 sudden shift toward international sends for this account",
    );
  }
}
