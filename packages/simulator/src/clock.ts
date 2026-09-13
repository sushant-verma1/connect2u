/**
 * R9.4: time the simulation reasons about, never time it waits through. Every duration
 * a scenario produces (a channel timeout, a response delay) is added here explicitly;
 * nothing in the runner ever calls `setTimeout` for simulated time or reads the system
 * clock — that's what lets 10,000 verifications with 20s timeouts finish in seconds of
 * real wall-clock time instead of minutes.
 */
export class VirtualClock {
  private currentMs = 0;

  get nowMs(): number {
    return this.currentMs;
  }

  advanceBy(ms: number): void {
    if (ms < 0) {
      throw new Error(`VirtualClock cannot advance backwards (got ${ms}ms)`);
    }
    this.currentMs += ms;
  }
}
