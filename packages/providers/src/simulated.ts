import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Provider, SendParams, SendResult } from "./provider.js";

export class SimulatedProviderError extends Error {
  constructor(public readonly code: "provider_error") {
    super("SimulatedProvider: simulated send failure");
  }
}

export type SimulatedProviderOptions = Readonly<{
  latencyMs?: number;
  failureRate?: number;
  /** Injectable so the simulator (R9.3) can thread a seeded PRNG through instead of I6-forbidden Math.random. */
  random?: () => number;
}>;

const defaultRandom = (): number => randomInt(0, 1_000_000) / 1_000_000;

/**
 * R5.3: the primary delivery path for Phase 1+, not a test double.
 *
 * `sentMessages` is the one sanctioned way to recover a code in a test — the server
 * itself never exposes plaintext codes (I4), so tests must read them from the same
 * place a real WhatsApp/SMS sandbox would let you inspect an outbound message, not by
 * reconstructing them from the stored hash.
 */
export class SimulatedProvider implements Provider {
  private readonly latencyMs: number;
  private readonly failureRate: number;
  private readonly random: () => number;
  private readonly sent: SendParams[] = [];

  constructor(options: SimulatedProviderOptions = {}) {
    this.latencyMs = options.latencyMs ?? 50;
    this.failureRate = options.failureRate ?? 0;
    this.random = options.random ?? defaultRandom;
  }

  get sentMessages(): readonly SendParams[] {
    return this.sent;
  }

  async send(params: SendParams): Promise<SendResult> {
    await sleep(this.latencyMs);
    this.sent.push(params);
    if (this.random() < this.failureRate) {
      throw new SimulatedProviderError("provider_error");
    }
    return { providerMessageId: `sim_${randomInt(0, 1_000_000_000).toString(36)}` };
  }
}
