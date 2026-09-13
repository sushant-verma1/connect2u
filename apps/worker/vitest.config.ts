import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The queue/processor logic here is exercised end-to-end by apps/api's integration
    // suite (real Postgres + Redis + a live BullMQ worker) — nothing to unit-test yet.
    passWithNoTests: true,
  },
});
