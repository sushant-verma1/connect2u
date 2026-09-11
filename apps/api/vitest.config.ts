import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Container startup + 20x concurrency runs (T1) take longer than vitest's 5s default.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
