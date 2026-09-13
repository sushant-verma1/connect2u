// R9.3/I6: the one random source the entire simulation uses, threaded explicitly
// through every draw — never Math.random (forbidden repo-wide). mulberry32 is a
// small, well-known deterministic generator: same 32-bit seed, same infinite sequence
// of floats in [0, 1), on any machine, forever.
export type Prng = () => number;

export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
