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

/** R5.3: the primary delivery path for Phase 1+, not a test double. */
export class SimulatedProvider implements Provider {
  private readonly latencyMs: number;
  private readonly failureRate: number;
  private readonly random: () => number;

  constructor(options: SimulatedProviderOptions = {}) {
    this.latencyMs = options.latencyMs ?? 50;
    this.failureRate = options.failureRate ?? 0;
    this.random = options.random ?? defaultRandom;
  }

  async send(_params: SendParams): Promise<SendResult> {
    await sleep(this.latencyMs);
    if (this.random() < this.failureRate) {
      throw new SimulatedProviderError("provider_error");
    }
    return { providerMessageId: `sim_${randomInt(0, 1_000_000_000).toString(36)}` };
  }
}
