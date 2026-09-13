import type { Channel } from "@otp-router/core/fallback/channel-chain";
import type { Prng } from "./prng.js";

/**
 * The model behind G1's central claim — a channel can deliver perfectly and still
 * verify poorly. Three independent traits per synthetic phone number, each drawn once
 * from the seeded PRNG:
 *
 * - `whatsappReachableShare`: the fraction of numbers actually reachable on WhatsApp at
 *   all (PROJECT.md/ARCHITECTURE.md §10). A provider send to an unreachable number can
 *   still report success and a "delivered" webhook can still fire (that's exactly what
 *   happens in production when a message lands in an archived or unread chat) — the
 *   population model is what makes that message never get *used*, which is the gap
 *   between delivery rate and verification rate that a delivery-rate-scored router
 *   can't see. SMS has no reachability gate here: near-universal inbox visibility is
 *   the reduced-scope assumption this project makes about SMS (PROJECT.md).
 * - `abandonRate`: the fraction of people who never complete verification on *any*
 *   channel regardless of delivery — the flow itself loses them, not any one channel.
 * - `whatsappBrokenShare` (default 0): a distinct, smaller trait from
 *   `whatsappReachableShare` above — these numbers don't just go unused, delivery to
 *   them genuinely fails every time (a send error or a lost webhook), which is exactly
 *   the repeatable signal G3's per-phone-hash capability cache learns from. G1's
 *   unreachable-but-"delivered" numbers are the opposite case on purpose (see below)
 *   and are invisible to capability filtering — only this trait is visible to it.
 * - `meanResponseDelayMs` per channel: given someone is reachable and hasn't abandoned,
 *   how long they take to act once a message lands. Drawn from an exponential
 *   distribution (memoryless — the standard choice for "time until a person does the
 *   thing," with no built-in bias toward early or late action). A delay longer than the
 *   channel's own timeout is indistinguishable, in this model, from never responding on
 *   that channel — mirroring T5's real race between a slow user and the fallback timer.
 */
export type PopulationConfig = Readonly<{
  whatsappReachableShare: number;
  abandonRate: number;
  whatsappBrokenShare?: number;
  meanResponseDelayMs: Readonly<Record<Channel, number>>;
}>;

export type SyntheticUser = Readonly<{
  whatsappReachable: boolean;
  abandonsEntirely: boolean;
  whatsappBroken: boolean;
}>;

export function drawUser(prng: Prng, config: PopulationConfig): SyntheticUser {
  return {
    whatsappReachable: prng() < config.whatsappReachableShare,
    abandonsEntirely: prng() < config.abandonRate,
    whatsappBroken: prng() < (config.whatsappBrokenShare ?? 0),
  };
}

export function isReachable(user: SyntheticUser, channel: Channel): boolean {
  return channel === "whatsapp" ? user.whatsappReachable : true;
}

/** Exponential inverse-CDF sample: `-ln(U) * mean`, U uniform on (0, 1]. */
export function drawResponseDelayMs(prng: Prng, meanMs: number): number {
  const u = 1 - prng(); // (0, 1], never exactly 0 — avoids log(0)
  return -Math.log(u) * meanMs;
}

/**
 * R9.1 provider latency: exponential, same shape as response delay, but mixed with a
 * `lateDeliveryRate` chance of drawing from a slower distribution instead — a carrier
 * hiccup on some fraction of sends rather than uniformly heavier tails on all of them.
 */
export function drawProviderLatencyMs(
  prng: Prng,
  meanMs: number,
  lateDeliveryRate: number,
  lateDeliveryExtraMs: number,
): number {
  const isLate = prng() < lateDeliveryRate;
  return drawResponseDelayMs(prng, isLate ? meanMs + lateDeliveryExtraMs : meanMs);
}
