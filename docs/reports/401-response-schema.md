# The 401 response schema question

## The question

`createApiKeyAuth` (`apps/api/src/auth/api-key-auth.ts`) sends its `401` responses from a
Fastify `preHandler`, before the route's own handler ever runs. None of the three
verification routes declared a `401` entry in their `schema.response` map, yet the
responses came back correctly shaped (`{ "error": "unauthorized" }`) and Zod validation
never complained. Before adding queue work, was that an oversight, or intentional?

## How Fastify actually serializes a `preHandler` reply

Read from `fastify@5.12.4`'s source (`lib/reply.js`, `lib/route.js`):

- Every route's response schemas are compiled once at route-registration time into a
  `context` object attached to the route.
- That `context` (`this[kRouteContext]` on the `Reply` instance) is assigned to the
  `Reply` when the request is first routed — **before any hook runs**, including
  `preHandler`.
- `reply.send()` looks up the serializer for the current status code via
  `getSchemaSerializer(context, statusCode, ...)` off that same `context`, regardless of
  which lifecycle stage (`preHandler`, handler, `onError`, ...) called `send()`.

So a schema declared for a status code applies uniformly no matter where in the request
lifecycle the reply is sent from. There is no special-casing for `preHandler`.

## Why it "worked" anyway

Since no `401` schema was registered, Fastify had no compiled serializer to look up for
that status code, so it fell back to plain `JSON.stringify`. That happened to match
`errorResponseSchema`'s shape (`{ error: string }`) by construction, so nothing ever
caught the gap in CI or in manual testing — it wasn't validated, it just wasn't wrong.

## Fix

Added `401: errorResponseSchema` to all three routes' response maps
(`apps/api/src/routes/verification.ts`), and to the new dead-letter inspection route.
This is not redundant with the `preHandler` behavior — it's what makes the `401` shape an
enforced contract instead of an accident: Zod's serializer will now strip any accidental
extra fields and throw in dev if the shape ever drifts (e.g. someone changes
`api-key-auth.ts` to send `{ message: ... }` instead of `{ error: ... }`).
