# TECHSTACK.md

**This list is exhaustive.** Anything not named here requires explicit approval before being
added. See AGENTS.md §4.

Selection rule: stay close to what the developer already knows, so time goes into routing,
fallback timing, and concurrency rather than into learning a framework.

---

## Runtime

| Package      | Version             | Why                                                  |
| ------------ | ------------------- | ---------------------------------------------------- |
| `node`       | 22 LTS              | Native fetch, stable test runner                     |
| `typescript` | 5.x, `strict: true` | Non-negotiable given the number of state transitions |
| `pnpm`       | 9.x                 | Workspaces for the monorepo; stricter than npm       |
| `tsx`        | latest              | Dev-time TS execution, no build step                 |

---

## API layer

| Package                     | Why                                                                                                                                                                                                                                                                                                                                       | Rejected alternative                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `fastify` 5.x               | Schema validation built in, which matters when two endpoints are the entire public contract. Encapsulation model maps onto multi-tenancy. Fastify 4 was retired June 2025 — 5.x is the only supported major.                                                                                                                              | **Express** — would need validation bolted on. **NestJS** — good structure, but the learning overhead costs a week. |
| `zod` 3.x                   | One source of truth for request validation, config parsing, routing-policy schemas, and webhook payloads. Generates the OpenAPI spec.                                                                                                                                                                                                     | `joi` (no type inference), `class-validator` (needs decorators)                                                     |
| `fastify-type-provider-zod` | Wires Zod into routes with full inference                                                                                                                                                                                                                                                                                                 | —                                                                                                                   |
| `@fastify/helmet`           | Security headers                                                                                                                                                                                                                                                                                                                          | —                                                                                                                   |
| `@fastify/cookie`           | R13.4: parses/signs the session cookie (`sid`) on the credential path — quoted values, encoding, multiple `Set-Cookie` headers are real edge cases there, not somewhere to hand-roll. Two dependencies of its own (`cookie`, `fastify-plugin`), both zero-dependency, official Fastify org package. Approved as a §4 request (AGENTS.md). | Hand-written parser — restraint is right in general, wrong on a credential path.                                    |
| `@fastify/rate-limit`       | Coarse IP limiting only — real per-number and per-account limits live in Redis Lua                                                                                                                                                                                                                                                        | —                                                                                                                   |

---

## Database

| Package             | Why                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` 16       | Needs real transactions and conditional updates for ARCHITECTURE.md §8                                                             |
| `drizzle-orm`       | SQL-shaped, so the atomic `UPDATE ... WHERE status='pending'` pattern stays under your control. Strong inference, no codegen step. |
| `drizzle-kit`       | Migrations, versioned and committed                                                                                                |
| `postgres` (driver) | Connection pooling                                                                                                                 |

**Rejected:** `prisma` — heavier runtime, extra generate step, awkward for precise conditional
updates. Fine generally, wrong here.

---

## Cache, TTL, rate limiting

| Package   | Why                                                             |
| --------- | --------------------------------------------------------------- |
| `redis` 7 | OTP TTL, rate-limit counters, idempotency store, BullMQ backing |
| `ioredis` | Mature client, Lua support                                      |

Hand-written **Lua scripts** for sliding-window rate limiting. Atomic check-and-increment in
one round trip, not three.

**Rule:** Redis holds ephemeral state. Postgres is the record of truth. Wiping Redis loses
in-flight TTLs, never history.

---

## Queue

| Package               | Why                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bullmq` 5.x          | Delayed jobs are the fallback timer. Cancellation, backoff retry, repeatable jobs. Runs on existing Redis. |
| `@bull-board/fastify` | Dev-only queue inspection                                                                                  |

---

## Providers

| Package             | Why                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| native `fetch`      | Meta Cloud API. The official SDKs add nothing here.                                             |
| `twilio`            | **LATER only.** See PROJECT.md constraints — trial expires in 30 days and blocks custom bodies. |
| `libphonenumber-js` | E.164 normalisation, country detection, number-type checks                                      |

`SimulatedProvider` is hand-written in `packages/providers`. It is the primary path, not a
test double.

---

## Crypto

| Package                  | Why                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| node `crypto` (built-in) | `randomInt` for codes, `createHmac` for code and phone hashing, `timingSafeEqual` for comparison. No library needed. |
| `argon2`                 | **API keys only.** Never for OTP codes — see PROJECT.md security posture.                                            |

`Math.random` is forbidden anywhere in the codebase.

---

## Testing

| Package                                               | Why                                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `vitest`                                              | Fast, TS-native                                                                                                                     |
| `@testcontainers/postgresql`, `@testcontainers/redis` | Real Postgres and Redis in integration tests. **Do not mock the database** when the project is about correctness under concurrency. |
| `@fast-check/vitest`                                  | Property-based tests on the state machine — every event sequence lands in a valid terminal state. High signal, low effort.          |
| `seedrandom`                                          | Deterministic PRNG for the simulator                                                                                                |

---

## Simulator

| Package      | Why                           |
| ------------ | ----------------------------- |
| `yaml`       | Human-editable scenario files |
| `cli-table3` | Readable report output        |

Virtual clock is hand-written. No library.

---

## Dashboard

| Package                 | Why                                        |
| ----------------------- | ------------------------------------------ |
| `react` 18 + `vite`     | Known, fast                                |
| `@tanstack/react-query` | Polling, caching, background refetch       |
| `recharts`              | Time series and bars without a week of D3  |
| `tailwindcss`           | Fast iteration on the lowest-priority part |
| `shadcn/ui`             | Copy-in components, no dependency weight   |

**Not:** websockets, SSR, Next.js, or any state management library.

---

## Observability

| Package       | Why                                  |
| ------------- | ------------------------------------ |
| `pino`        | Structured JSON logs, Fastify-native |
| `pino-pretty` | Dev only                             |
| `ulid`        | Sortable IDs for `verification_id`   |

Correlation IDs are hand-threaded, not a library.

---

## Tooling

| Package                         | Why                                                                         |
| ------------------------------- | --------------------------------------------------------------------------- |
| `eslint` + `@typescript-eslint` | —                                                                           |
| `prettier`                      | —                                                                           |
| `husky` + `lint-staged`         | Pre-commit                                                                  |
| `docker` + Docker Compose       | Local Postgres + Redis                                                      |
| `cloudflared`                   | Public webhook URL in dev; unlike ngrok free tier the URL survives restarts |
| GitHub Actions                  | Lint, typecheck, test, and run the simulator on every PR                    |

---

## Forbidden

Adding any of these is a rejected change, not a discussion.

| Forbidden                         | Why                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Kafka, RabbitMQ, SQS              | BullMQ on existing Redis is sufficient. Adding Kafka is resume-padding an interviewer sees through. |
| Kubernetes, Helm                  | Three processes.                                                                                    |
| gRPC, tRPC                        | Customers want REST.                                                                                |
| MongoDB, DynamoDB                 | Needs transactions and conditional updates.                                                         |
| InfluxDB, TimescaleDB, ClickHouse | Postgres with a materialised view handles this volume.                                              |
| Any LLM or AI SDK                 | Nothing here needs one; adding one weakens the project.                                             |
| `moment`                          | Dead. Use native `Date` / `Intl`.                                                                   |
| `request`, `axios`                | Native `fetch`.                                                                                     |
| `lodash`                          | Node 22 covers it.                                                                                  |
| `bcrypt` / `argon2` for OTP codes | Wrong primitive — see PROJECT.md security posture.                                                  |
| ORMs other than Drizzle           | Consistency.                                                                                        |
| A second HTTP framework           | Consistency.                                                                                        |
| `dotenv` in production code paths | Config comes from the Zod-validated module only.                                                    |

---

## Adding a dependency

Ask before installing. The request must state: what it does, why nothing listed here covers
it, its weekly downloads and last publish date, and its transitive dependency count.

Default answer is no. This is a portfolio project judged partly on restraint, and a
`package.json` with 140 dependencies says something a reviewer will notice.
