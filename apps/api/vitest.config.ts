import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Container startup + 20x concurrency runs (T1) take longer than vitest's 5s default.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each integration file spins up its own Postgres + Redis containers. Running them
    // concurrently makes container pairs compete for host CPU, which is exactly what
    // flakes the R1.1.5 100ms-response assertion — timing tests need real isolation.
    fileParallelism: false,
  },
});
