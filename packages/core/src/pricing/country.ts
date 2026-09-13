// G8/PROJECT.md: Meta's own rate card is split into exactly two corridors — Indian
// domestic and everything else — so that's the bucket cost lookups key on. A one-line
// E.164 prefix check is all a two-bucket split needs; a real per-country card
// (ARCHITECTURE.md-style corridor pricing) is future work, not this project's scope.
export type CostCountry = "IN" | "INTL";

export function classifyCountry(e164PhoneNumber: string): CostCountry {
  return e164PhoneNumber.startsWith("+91") ? "IN" : "INTL";
}
