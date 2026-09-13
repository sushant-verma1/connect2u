import { runScenario } from "./runner.js";
import type { Report } from "./report.js";
import type { ScenarioConfig } from "./scenario.js";

// R9.7: two policies, identical traffic. "Identical" means the same population,
// providers, seed, and arrival pattern — arm B is `scenarioA` with only its
// routing (`policy` or `fixedChain`) overridden, never a separately hand-built
// scenario that could quietly drift from arm A.
export type ComparisonReport = Readonly<{
  a: Report;
  b: Report;
  delta: Readonly<{
    verificationRate: number;
    fallbackRate: number;
    timeToVerifyMsP50: number | null;
    timeToVerifyMsP95: number | null;
    // R9.5/G8: the metric this whole comparison exists to surface — a fixed chain that
    // wastes a send on a channel it was never going to convert on pays for that send
    // *and* pays again for the fallback that actually works. `null` propagates rather
    // than assumes 0 if either arm hit an unpriced corridor.
    costPerVerifiedMicros: number | null;
  }>;
}>;

function nullableDelta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

export async function compareScenarios(
  scenarioA: ScenarioConfig,
  routingOverrideB: Pick<ScenarioConfig, "policy" | "fixedChain">,
): Promise<ComparisonReport> {
  const scenarioB: ScenarioConfig = {
    ...scenarioA,
    policy: undefined,
    fixedChain: undefined,
    ...routingOverrideB,
  };

  const a = await runScenario(scenarioA);
  const b = await runScenario(scenarioB);

  return {
    a,
    b,
    delta: {
      verificationRate: b.verificationRate - a.verificationRate,
      fallbackRate: b.fallbackRate - a.fallbackRate,
      timeToVerifyMsP50: nullableDelta(a.timeToVerifyMsP50, b.timeToVerifyMsP50),
      timeToVerifyMsP95: nullableDelta(a.timeToVerifyMsP95, b.timeToVerifyMsP95),
      costPerVerifiedMicros: nullableDelta(a.costPerVerifiedMicros, b.costPerVerifiedMicros),
    },
  };
}
