import { createPgClient } from "@otp-router/db/client";
import { SimulatedProvider } from "@otp-router/providers/simulated";
import { MetaProvider } from "@otp-router/providers/meta";
import { providerErrorCode, type Provider, type SendParams } from "@otp-router/providers/provider";
import {
  SCORE_RECOMPUTE_INTERVAL_MS,
  SCORE_RECOMPUTE_JOB_ID,
} from "@otp-router/core/queue/score-recompute-job";
import { Redis } from "ioredis";
import { pino } from "pino";
import { loadConfig } from "./config.js";
import { startBullBoard } from "./bull-board.js";
import { createDeliveryWorker } from "./queue/delivery-worker.js";
import { createFallbackTimerWorker } from "./queue/fallback-worker.js";
import { closeQueues, createQueues } from "./queue/queues.js";
import { createScoreRecomputeWorker } from "./queue/score-recompute-worker.js";
import { createWebhookIngestWorker } from "./queue/webhook-worker.js";

const config = loadConfig();
const logger = pino({
  level: config.logLevel,
  transport: config.nodeEnv === "development" ? { target: "pino-pretty" } : undefined,
});

const pg = createPgClient(config.databaseUrl);

// BullMQ requires maxRetriesPerRequest: null on any connection it drives, and — more
// importantly — each Worker needs its *own* connection. A Worker's blocking read
// occupies the whole physical connection until a job arrives or it times out; sharing
// one connection across multiple Workers (or a Worker and a Queue producer) means an
// idle Worker's long block silently stalls every other command queued behind it on that
// socket, including this process's own `queue.add()` calls.
function createConnection(): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

const queueConnection = createConnection();
const deliveryConnection = createConnection();
const fallbackConnection = createConnection();
const webhookConnection = createConnection();
const scoreRecomputeConnection = createConnection();

// R5.3: SimulatedProvider is the primary delivery path, always — this is what every
// test and simulation run uses, and what handles sms and every whatsapp send that
// isn't explicitly opted into the session-message path below.
const simulatedProvider = new SimulatedProvider();

// README "WhatsApp session messages (demo only)": real Meta delivery is reachable only
// when the flag is on *and* all three credentials are present — never by accident, and
// never because credentials alone were configured (that's what registers the webhook
// route in apps/api; sending is a separate, stricter gate).
const metaProvider =
  config.metaAllowSessionMessages &&
  config.metaPhoneNumberId &&
  config.metaAccessToken &&
  config.metaAppSecret
    ? new MetaProvider({
        phoneNumberId: config.metaPhoneNumberId,
        accessToken: config.metaAccessToken,
        appSecret: config.metaAppSecret,
        allowSessionMessages: true,
      })
    : null;

// Routes whatsapp to the real Meta send when wired, every other channel (and whatsapp
// whenever Meta isn't wired) to SimulatedProvider. mapErrorCode is shared and structural
// (packages/providers/src/provider.ts's providerErrorCode) — it classifies either
// adapter's error class correctly without knowing which one threw.
const provider: Pick<Provider, "send" | "mapErrorCode"> = {
  send: (params: SendParams) =>
    metaProvider && params.channel === "whatsapp"
      ? metaProvider.send(params)
      : simulatedProvider.send(params),
  mapErrorCode: providerErrorCode,
};
const providerName = metaProvider ? { whatsapp: "meta" } : undefined;

const keys = {
  phoneEncryptionKey: config.phoneEncryptionKey,
  codeEncryptionKey: config.codeEncryptionKey,
};

const queues = createQueues(queueConnection);
const deliveryWorker = createDeliveryWorker(
  deliveryConnection,
  pg,
  provider,
  logger,
  queues,
  keys,
  undefined,
  providerName,
);
const fallbackWorker = createFallbackTimerWorker(fallbackConnection, pg, logger, queues, keys);
const webhookWorker = createWebhookIngestWorker(webhookConnection, pg, logger, queues, keys);
const scoreRecomputeWorker = createScoreRecomputeWorker(scoreRecomputeConnection, pg, logger);

// R3.8: scheduled here, once, at startup — `upsertJobScheduler` is idempotent on
// `SCORE_RECOMPUTE_JOB_ID`, so restarting the worker updates the existing schedule
// rather than adding a second one.
await queues.scoreRecomputeQueue.upsertJobScheduler(SCORE_RECOMPUTE_JOB_ID, {
  every: SCORE_RECOMPUTE_INTERVAL_MS,
});

const bullBoard =
  config.nodeEnv === "development"
    ? await startBullBoard(
        [
          queues.deliveryQueue,
          queues.deadLetterQueue,
          queues.fallbackQueue,
          queues.webhookIngestQueue,
          queues.scoreRecomputeQueue,
        ],
        config.workerPort,
        // /dev/outbox reads SimulatedProvider.sentWithProviderIds specifically — the
        // delegate above isn't a SimulatedProvider, so Bull Board always gets the real
        // instance, never the per-channel wrapper.
        simulatedProvider,
      )
    : null;

logger.info({ port: bullBoard ? config.workerPort : undefined }, "worker started");

async function shutdown(): Promise<void> {
  await Promise.all([
    deliveryWorker.close(),
    fallbackWorker.close(),
    webhookWorker.close(),
    scoreRecomputeWorker.close(),
  ]);
  await closeQueues(queues);
  await bullBoard?.close();
  await pg.end();
  queueConnection.disconnect();
  deliveryConnection.disconnect();
  fallbackConnection.disconnect();
  webhookConnection.disconnect();
  scoreRecomputeConnection.disconnect();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
