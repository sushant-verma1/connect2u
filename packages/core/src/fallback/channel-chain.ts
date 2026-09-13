// The single source of truth for which channels exist — routing/policy.ts's Zod enum
// and everything else that needs "every known channel" derive from this array.
export const CHANNELS = ["whatsapp", "sms"] as const;

export type Channel = (typeof CHANNELS)[number];

const CHANNEL_SET: ReadonlySet<string> = new Set<Channel>(CHANNELS);

/** Narrows a value loaded from storage (e.g. a jsonb column typed as `string[]`). */
export function isChannel(value: string): value is Channel {
  return CHANNEL_SET.has(value);
}

// R4.7: a hard cap independent of how many channels a customer requests. Two channels
// exist today; this exists so the cap is enforced in code now rather than bolted on
// once a third channel makes it matter.
export const MAX_FALLBACK_CHANNELS = 3;

export const DEFAULT_CHANNEL_CHAIN: readonly Channel[] = ["whatsapp", "sms"];

// ARCHITECTURE.md §4: 20s for WhatsApp, 30s for SMS. Below ~15s you double-send
// constantly and pay twice; above ~30s the user has already given up. Fixed here as a
// placeholder — Phase 5's routing policy makes this a per-account, per-channel value
// (R4.5); until then every account gets the same reasoning applied to it.
export const CHANNEL_TIMEOUT_MS: Readonly<Record<Channel, number>> = {
  whatsapp: 20_000,
  sms: 30_000,
};

/** R4.7: the chain a verification will try, in order, capped. */
export function buildChannelChain(requested: readonly Channel[] | undefined): readonly Channel[] {
  const chain = requested && requested.length > 0 ? requested : DEFAULT_CHANNEL_CHAIN;
  return chain.slice(0, MAX_FALLBACK_CHANNELS);
}

/**
 * R4.4/R2.3: the next channel to try, or `null` once the chain is exhausted. Pure — the
 * caller (apps/worker) is the one that knows which channels have actually been
 * attempted; this just picks the first one in the chain that isn't in that list.
 */
export function nextChannel(
  chain: readonly Channel[],
  attemptedChannels: readonly string[],
): Channel | null {
  return chain.find((channel) => !attemptedChannels.includes(channel)) ?? null;
}
