export { createPrng, type Prng } from "./prng.js";
export { VirtualClock } from "./clock.js";
export {
  drawUser,
  drawResponseDelayMs,
  drawProviderLatencyMs,
  isReachable,
  type PopulationConfig,
  type SyntheticUser,
} from "./population.js";
export type { ChannelProviderConfig, ScenarioConfig } from "./scenario.js";
export {
  runScenario,
  runScenarioDetailed,
  type VerificationResult,
  type ScenarioRun,
} from "./runner.js";
export { buildReport, type Report } from "./report.js";
export { loadScenarioFile, loadPreset, PRESET_NAMES, type PresetName } from "./scenario-loader.js";
export { compareScenarios, type ComparisonReport } from "./ab.js";
