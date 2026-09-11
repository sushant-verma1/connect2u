import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";

const HEADER = "x-correlation-id";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * Hand-threaded per TECHSTACK.md (no correlation-ID library). Reuses an inbound ID so
 * traces stay joined across services (R11.1), otherwise mints one.
 */
export function registerCorrelationId(app: FastifyInstance): void {
  app.decorateRequest("correlationId", "");

  app.addHook("onRequest", (request, reply, done) => {
    const incoming = request.headers[HEADER];
    const correlationId = typeof incoming === "string" && incoming.length > 0 ? incoming : ulid();

    request.correlationId = correlationId;
    request.log = request.log.child({ correlationId });
    reply.header(HEADER, correlationId);
    done();
  });
}
