import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  isRecord,
  providerErrorCode,
  type ParsedWebhookEvent,
  type Provider,
  type ProviderError,
  type SendParams,
  type SendResult,
} from "./provider.js";

export class SimulatedProviderError extends Error {
  constructor(public readonly code: ProviderError["code"]) {
    super(`SimulatedProvider: simulated send failure (${code})`);
  }
}

export type SimulatedProviderOptions = Readonly<{
  latencyMs?: number;
  failureRate?: number;
  /** R5.6: which taxonomy code a simulated failure reports. Defaults to the transient case. */
  failureCode?: ProviderError["code"];
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
  private readonly failureCode: ProviderError["code"];
  private readonly random: () => number;
  private readonly sent: SendParams[] = [];

  constructor(options: SimulatedProviderOptions = {}) {
    this.latencyMs = options.latencyMs ?? 50;
    this.failureRate = options.failureRate ?? 0;
    this.failureCode = options.failureCode ?? "provider_error";
    this.random = options.random ?? defaultRandom;
  }

  get sentMessages(): readonly SendParams[] {
    return this.sent;
  }

  async send(params: SendParams): Promise<SendResult> {
    // A real timer at 0ms still costs a real macrotask tick — negligible once, but
    // packages/simulator (R9.4) calls this thousands of times per run with a virtual
    // clock standing in for delivery timing, so that overhead must not exist at all.
    // Do not delete or generalize this branch: latencyMs=0 now resolves synchronously
    // (no tick) while every other value still yields, which is intentional for the
    // simulator but means an integration test relying on this provider's ordering
    // could pass by accident at latencyMs=0 while masking a real race elsewhere.
    if (this.latencyMs > 0) {
      await sleep(this.latencyMs);
    }
    this.sent.push(params);
    if (this.random() < this.failureRate) {
      throw new SimulatedProviderError(this.failureCode);
    }
    return { providerMessageId: `sim_${randomInt(0, 1_000_000_000).toString(36)}` };
  }

  // No signature scheme exists to simulate — R6.1 doesn't apply to a fake channel with
  // no wire format of its own; `/v1/webhooks/simulated` never calls this.
  verifySignature(): boolean {
    return true;
  }

  parseWebhook(body: unknown): readonly ParsedWebhookEvent[] {
    if (
      !isRecord(body) ||
      typeof body.provider_message_id !== "string" ||
      typeof body.event_type !== "string"
    ) {
      return [];
    }
    return [
      { providerMessageId: body.provider_message_id, eventType: body.event_type, payload: body },
    ];
  }

  mapErrorCode(err: unknown): ProviderError["code"] {
    return providerErrorCode(err);
  }
}
