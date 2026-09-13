import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { PgClient } from "@otp-router/db/client";
import {
  SCORE_RECOMPUTE_QUEUE_NAME,
  type ScoreRecomputeJobData,
} from "@otp-router/core/queue/score-recompute-job";
import { createScoreRecomputeProcessor } from "../processors/score-recompute.js";

export function createScoreRecomputeWorker(
  connection: Redis,
  pg: PgClient,
  logger: Logger,
): Worker<ScoreRecomputeJobData> {
  const processScoreRecompute = createScoreRecomputeProcessor(pg, logger);

  const worker = new Worker<ScoreRecomputeJobData>(
    SCORE_RECOMPUTE_QUEUE_NAME,
    processScoreRecompute,
    {
      connection,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "score-recompute job failed");
  });

  return worker;
}
