# Auth flow audit — session lifecycle on both sign-in paths

Scope: how a session is minted, stored, carried, resolved and destroyed on the
email/password path and the Google path, plus four specific questions raised from
production logs.

Audited at commit `0772b84`. **F1 and F2 have since been fixed** (see their entries);
**F3–F8 remain open and are not scheduled** — they are documented here as findings, not
as work in progress. §1–§5 describe the flow as audited; the only behaviour they
describe that has since changed is the Google callback's two error branches, both now
redirects rather than JSON bodies (F2).

---

## 1. Where the session token is generated

One place, for both paths: `createSession` (`apps/api/src/auth/session.ts:25`).

```
randomBytes(32).toString("base64url")   // session.ts:19
```

32 bytes from `node:crypto`, base64url-encoded (43 chars). No account data is encoded
into it — it is an opaque lookup key, not a JWT, so there is nothing in it to verify or
to leak.

Four call sites, no others (`grep createSession`):

| Path                                            | Call site                   |
| ----------------------------------------------- | --------------------------- |
| Password signup                                 | `routes/auth.ts:120`        |
| Password login                                  | `routes/auth.ts:161`        |
| Google, returning user (`google_sub` matched)   | `routes/auth-google.ts:102` |
| Google, first-time user (account just inserted) | `routes/auth-google.ts:125` |

All four immediately call `setSessionCookie(reply, token, config)` on the next line.
There is no other function in the codebase that mints or re-issues a session.

## 2. Where it's stored

Redis, string key, no value structure:

```
SETEX session:<token> 28800 <account_id>      // session.ts:27
```

The token is the key; the account id is the whole value. Postgres holds no session
table — consistent with TECHSTACK.md's rule that ephemeral state lives in Redis.

Consequences worth naming, because they shape findings F3 and F6 below:

- There is **no index from account → sessions**. Given an account id you cannot
  enumerate, count or revoke its sessions. Revocation is only possible by presenting the
  token itself.
- Sessions survive an API deploy (Redis is external) but not a Redis flush.
- A session is not invalidated by anything happening to the account row; the only
  account-side check is the liveness check `sessionAuth` performs per request (§4).

## 3. Exact cookie attributes

Both paths call the **same** `setSessionCookie` (`session.ts:42`), so the attribute set
is identical by construction — see Q2 in §6. Emitted headers, captured by running the
exact option objects from `session.ts` and `auth-google.ts` through `@fastify/cookie`:

**`sid` — set by password signup, password login, and both Google branches**

```
NODE_ENV=production   sid=<token>; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Lax
NODE_ENV=development  sid=<token>; Max-Age=28800; Path=/; HttpOnly; SameSite=Lax
```

**`oauth_tx` — set only by `GET /v1/auth/google` (`auth-google.ts:52`)**

```
NODE_ENV=production   oauth_tx=<state>.<verifier>; Max-Age=600; Path=/v1/auth/google; HttpOnly; Secure; SameSite=Lax
NODE_ENV=development  oauth_tx=<state>.<verifier>; Max-Age=600; Path=/v1/auth/google; HttpOnly; SameSite=Lax
```

**`sid` cleared by logout** (`clearSessionCookie`, `session.ts:52`)

```
sid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax
```

**`oauth_tx` cleared by the callback** (`auth-google.ts:75`)

```
oauth_tx=; Max-Age=0; Path=/v1/auth/google; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax
```

Notes on these:

- No `Domain` attribute anywhere → host-only cookies, not shared with subdomains.
  Correct for a single-origin dashboard.
- Cookies are **not signed** (`app.register(cookie)` with no secret, `app.ts:54`).
  Deliberate and sound: the value is 32 random bytes that only matter as a Redis key
  lookup, so a forged value is a cache miss, not a forged identity.
- `secure` is derived from `config.nodeEnv === "production"`, **not** from the request
  scheme. See F4.
- The `oauth_tx` clear omits `Secure`. Cookie deletion matches on name/domain/path only,
  so this does delete the `Secure` cookie over HTTPS. Not a defect, but the asymmetry
  with `clearSessionCookie` (which does pass `secure`) is unintentional-looking.
- `Path=/v1/auth/google` on `oauth_tx` is a prefix of the callback path
  `/v1/auth/google/callback`, so the cookie is sent on the callback. Verified against the
  path-match rule, and exercised by `phase10-onboarding.integration.test.ts:66`.

**SameSite=Lax is load-bearing on the Google path.** The callback arrives as a
cross-site top-level GET navigation from `accounts.google.com`; Lax sends cookies on
exactly that, Strict would not. If `oauth_tx` is ever "hardened" to Strict the callback
breaks with `invalid_state` on every attempt.

## 4. How `sessionAuth` resolves it

`createSessionAuth` (`session.ts:72`) returns a Fastify `preHandler`. Three sequential
gates, each 401 `{"error":"unauthorized"}` with no distinguishing detail:

1. `request.cookies.sid` present? — no cookie → 401.
2. `GET session:<token>` in Redis returns an account id? — miss (expired, logged out,
   forged, flushed) → 401.
3. `findAccountById` returns a row **and** `account.status === "active"`? — no → 401.

On success it assigns `request.account`, the same `Account` shape `apiKeyAuth` produces,
so account-scoped queries downstream don't care which hook ran.

Cost per request: one Redis `GET` + one Postgres `SELECT`. Unlike `apiKeyAuth` there is
**no cache** — every session-authenticated request hits Postgres. That is what makes
gate 3 a real-time liveness check (a suspended account loses dashboard access on its
next request, no TTL to wait out), and it is the only revocation lever that doesn't need
the token in hand.

Routes behind it (`app.ts:89-92`): `/v1/auth/me`, `/v1/keys*`,
`/v1/dashboard/verifications/:id/trace`. Disjoint from `apiKeyAuth`'s route set by
construction — a session cannot call `/v1/verification/*` and an API key cannot call
`/v1/keys`, both covered by tests (`phase10-onboarding.integration.test.ts:141,158`).

## 5. TTL and expiry behaviour

|                  | Password signup                      | Password login | Google (both branches) |
| ---------------- | ------------------------------------ | -------------- | ---------------------- |
| Redis TTL        | 28800s                               | 28800s         | 28800s                 |
| Cookie `Max-Age` | 28800                                | 28800          | 28800                  |
| Set by           | `createSession` + `setSessionCookie` | same           | same                   |

Identical on every path — one constant, `SESSION_TTL_SECONDS` (`session.ts:13`), feeds
both the `SETEX` and the cookie `maxAge`.

**Absolute, not sliding.** `sessionAuth` does a bare `redis.get` with no `EXPIRE`
refresh, so the session dies 8h after mint regardless of activity. A user active for 8h
straight is logged out mid-task with no warning and no re-auth prompt beyond the
redirect to `/login`. Whether that's the intent is a product call; flagging it because
"8h idle timeout" and "8h hard cap" are easy to confuse and the comment at `session.ts:10`
reads as if it means the former.

Cookie and Redis expiries are set in the same request, so they land on the same
wall-clock second. Two follow-on behaviours:

- Because `Max-Age` is set, the cookie is **persistent** — it survives a browser
  restart within the 8h. It is not a session cookie despite the name.
- If Redis expires the key first (clock skew, or a Redis restart without persistence),
  the browser still sends a live-looking cookie and gets a 401. The dashboard handles
  this correctly — `AuthContext.tsx:28` treats 401 as "anonymous", not as an error to
  retry — so the user lands on `/login`.

No expiry difference between the two sign-in paths exists.

---

## 6. The four specific questions

### Q1 — Does the dashboard call `/v1/auth/me` before the cookie is set after the Google callback?

**No. The 401→200 pair in the logs is the expected signature of two separate page loads,
not a race.**

Traced end to end:

1. "Sign in with Google" is an `<a href="/v1/auth/google">` (`LoginPage.tsx:78`,
   `api.ts:58`) — a **top-level navigation**, not `fetch`. The SPA is torn down here.
2. `GET /v1/auth/google` sets `oauth_tx`, 302s to Google.
3. Google 302s the browser to `${DASHBOARD_ORIGIN}/v1/auth/google/callback`, which nginx
   proxies to the API (`nginx.conf.template:23`).
4. The callback's response carries **both** `Set-Cookie: sid=...` and the
   `Location:` redirect in the same 302 (`auth-google.ts:126-127`). Browsers commit
   cookies from a redirect response before following its `Location`.
5. Only then does the dashboard document load, React mounts, `AuthProvider`'s single
   `useQuery({queryKey:["me"]})` fires (`AuthContext.tsx:22`) — with the cookie already
   in the jar.

`fetchMe` has exactly one caller, that `useQuery`. There is no timer, no retry
(`retry: false`), no second call site. There is no code path that can issue
`/v1/auth/me` between the callback response and the cookie being stored.

What produces the logged pair: the **first** page load (the user opening the dashboard
or `/login` while logged out) legitimately 401s — that's `RequireAuth` resolving to
anonymous and redirecting to `/login`. The user then clicks Google, and the OAuth
round-trip takes the "seconds" in question. The **second** page load, after the
callback, 200s. Two different documents, two different page loads.

To confirm against the logs rather than the code: the 401 should carry **no `sid`
cookie at all** on the request. A 401 on `/v1/auth/me` _with_ a `sid` cookie present
would be a different problem entirely (Redis miss — F3/F4 territory), and worth grepping
for before closing this out.

One real defect found on this path while tracing it, though not the one suspected — see
**F2**.

### Q2 — Are cookie attributes identical between the password path and the Google path?

**Yes, and they cannot diverge without a code change.** All four mint sites call the same
`setSessionCookie(reply, token, config)`; no call site passes its own cookie options.
The emitted headers in §3 are byte-identical across paths.

The only variable is `config.nodeEnv`, which is **per-process, not per-path** — it cannot
differ between two requests to the same API instance. So a Secure/SameSite mismatch
_between the two sign-in paths_ is not the deployed failure mode.

Two adjacent risks that fit the "works locally, fails deployed" shape and are worth
ruling out instead:

- **F4** — `secure` keyed off `NODE_ENV` rather than the request scheme.
- **F5** — the `DASHBOARD_ORIGIN` invariant, which is what actually has to hold for the
  Google path's cookies to land on the right origin, and which nothing asserts.

### Q3 — Does logout delete the Redis key, or only clear the cookie?

**It deletes the Redis key.** The premise behind the question doesn't hold.

`POST /v1/auth/logout` (`routes/auth.ts:167`):

```ts
const token = request.cookies[SESSION_COOKIE_NAME];
if (token) {
  await destroySession(redis, token); // redis.del(`session:${token}`)  session.ts:32
}
clearSessionCookie(reply, config);
```

Redis `DEL` first, cookie clear second. The 8h-orphaned-token scenario in the question
does not occur — the token is dead server-side the moment logout returns, verified by
`phase10-onboarding.integration.test.ts:169` ("logout clears the session — the same
cookie is rejected afterwards") and again at `:120`.

What _is_ missing around it is F3 below: only the **presented** token is destroyed, and
there is no way to destroy any other.

### Q4 — Is `oauth_tx` cleared after the callback completes, success or failure?

**Yes, on every exit path.** `reply.clearCookie(OAUTH_TX_COOKIE, ...)` is
`auth-google.ts:75` — the second statement of the handler, before every branch. It
therefore covers the success 302, the `invalid_state` 400, the `email_already_registered`
409, and a thrown token exchange.

The last of those is the non-obvious one (the clear is set on a reply that is then
discarded in favour of the error handler's), so I verified it rather than assuming:

```
throw  -> 500 "oauth_tx=; Max-Age=0; Path=/v1/auth/google; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax"
400    -> 400 "oauth_tx=; Max-Age=0; Path=/v1/auth/google; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax"
```

Fastify's default error handler reuses the same `Reply`, so headers set before the throw
survive into the 500. Confirmed against `fastify@5` + `@fastify/cookie` as installed.

One correction to the comment at `auth-google.ts:78`: the cookie was described as
"single-use", but clearing it is a **browser-side** instruction only. Nothing records or
invalidates the `state`/`verifier` pair server-side, so a captured `oauth_tx` value
replayed alongside its matching `code` would still pass the state check. What actually
prevents replay is Google's one-shot authorization code plus PKCE — both intact. No
behaviour change needed; **the comment has been corrected** to say that.

---

## 7. Findings

Ordered by impact. None of these are fixed.

### F1 — `trustProxy` is unset, so every dashboard request shares one rate-limit bucket · **high, deployed-only** · FIXED

`buildApp` constructs Fastify with no `trustProxy` (`app.ts:36-41`), so `request.ip` is
the socket peer. In production the dashboard container's nginx proxies `/v1/*` to the API
(`nginx.conf.template:23`), which means **every** dashboard-originated request presents
the nginx container's IP.

Both auth rate limits are keyed on it:

- `rl:signup-ip:${request.ip}` — 5/hour (`routes/auth.ts:80`). The 6th signup **from
  anyone, anywhere** within an hour gets a 429.
- `rl:login-ip:${request.ip}` — 20/15min (`rate-limit.ts:186`). One global login bucket;
  also means one attacker can lock every user out of login.

This is invisible locally: the Vite dev proxy runs on the same host, so `request.ip`
still varies. nginx already sends `X-Forwarded-For` (`nginx.conf.template:26`) — the
header is there, nothing reads it. Also silently degrades `rl:ip` on `/v1/verification/start`
for any traffic routed through the same proxy.

**Fix:** `trustProxy: config.trustProxy` (`app.ts`), backed by a new `TRUST_PROXY` env
var defaulting to `"loopback,uniquelocal"` — loopback for the same-host Vite proxy in
dev, `uniquelocal` (10/8, 172.16/12, 192.168/16, fc00::/7) for a docker bridge or
Railway's internal IPv6 network. Public source addresses are deliberately not trusted,
so a client reaching the API directly has its `X-Forwarded-For` ignored entirely.

A trusted-peer list rather than a hop count, for two reasons. The first is the one
originally asked for — `true` would walk the whole chain and return its leftmost,
client-writable entry, handing every caller a bucket of its own choosing. The second was
found while implementing: **a numeric `trustProxy` is a no-op in fastify@5.12.4.**
`lib/request.js:51`:

```js
if (typeof tp === "number") {
  // Hop-count-only trust cannot validate the immediate peer. Fail closed so
  // direct clients cannot spoof X-Forwarded-* values by supplying enough hops.
  return function () {
    return false;
  };
}
```

So `trustProxy: 1` trusts nothing, `request.ip` stays the socket peer, and F1 would have
remained fully unfixed while appearing addressed. Measured against this Fastify version
rather than inferred from proxy-addr's own documented numeric semantics, which is where
the mismatch comes from. Peer-range trust resolves to the rightmost entry — the address
the proxy itself observed — which is the spoof-resistant one.

**Test:** `phase10-onboarding.integration.test.ts`, "two client IPs get separate
buckets, and a spoofed X-Forwarded-For doesn't buy a fresh one". Exhausts signup's
5/hour for one client IP, asserts a second IP is unaffected (this is the assertion that
fails when the proxy is untrusted — everything collapses into one bucket), then sends
`"<forged>, <real>"` and asserts the exhausted bucket still applies and the forged IP's
allowance was not spent. Confirmed failing against an untrusted peer before landing.

### F2 — The Google callback's failure branches render raw JSON to a top-level navigation · **medium** · FIXED

`auth-google.ts:88` (`400 invalid_state`) and `:114` (`409 email_already_registered`)
`send()` a JSON body into what is a full browser page load. The user sees
`{"error":"email_already_registered"}` as a bare white page with no navigation back to
the dashboard. Every other branch 302s.

The 409 is not an edge case — it fires for anyone who signed up with email/password and
later clicks "Sign in with Google", which is a normal thing for a user to do. The
non-auto-link policy behind it (D1) is right; its presentation is a dead end. The 400
also fires on the mundane case of an expired `oauth_tx` (user left the Google consent
screen open >10 min).

**Fix (409):** now `302 → ${dashboardOrigin}/login?error=email_already_registered`.
`LoginPage.tsx` maps the code to "That email already has a password account. Log in with
your password below." via a lookup table, not a passthrough — an unrecognised code
renders nothing rather than reflecting URL content into the page. D1's actual guarantees
are untouched and still asserted: no session minted, existing row unmodified; the
existing D1 test now checks the redirect target instead of the 409 status. The redirect
discloses nothing the caller didn't supply, matching signup's own 409 behaviour.

**Fix (400 `invalid_state`):** same treatment —
`302 → ${dashboardOrigin}/login?error=invalid_state`, through the same lookup table,
rendering "That sign-in attempt expired. Try signing in with Google again." Worded as a
retry rather than a security warning because the common cause is benign: an `oauth_tx`
cookie that aged past its 10-minute TTL while the consent screen sat open. The CSRF
defense itself is untouched — the token exchange is still never reached, and the
existing mismatched-state test still asserts no session and no account row.

Both callback branches now redirect; no exit from this handler renders a body.

### F3 — Sessions can only be revoked by presenting the token · **medium**

Storage is `session:<token> → account_id` with no reverse index (§2), so:

- No "log out of all devices".
- No way to terminate a session during incident response without flushing Redis.
- Nothing invalidates sibling sessions on a credential change. There is no
  password-change route today, so nothing is currently broken — but that route cannot be
  added safely until this is.

Partially mitigated by `sessionAuth`'s uncached per-request account-status check (§4),
which is a genuine kill switch at account granularity, just not at session granularity.

### F4 — `secure` is derived from `NODE_ENV`, not from the request scheme · **low**

`session.ts:47`, `auth-google.ts:56`. `NODE_ENV` is required with no default
(`config.ts:17`), so the app won't boot without it being set explicitly — which is the
right guard. But any deployed environment where it's set to something other than
`production` (a staging container, a preview deploy) serves `sid` **without `Secure`**
over HTTPS. It still works, which is why it would go unnoticed; it just loses the
downgrade protection.

### F5 — The `DASHBOARD_ORIGIN` invariant is unasserted · **low**

`redirectUri` is built as `${config.dashboardOrigin}/v1/auth/google/callback`
(`auth-google.ts:46`), and the post-callback redirect target is `config.dashboardOrigin`
(`:104`, `:127`). This is correct **only if** `DASHBOARD_ORIGIN` is the dashboard's
public origin (the one whose nginx proxies `/v1/*`) and not the API's own origin. If it
were ever set to the API origin, the flow would still complete — `sid` would just be set
on the API's origin and the final redirect would land on the API root, which has no
route. Documented in README:543 and `config.ts:56-63`; nothing enforces it, and the
failure is silent until a user tries to sign in.

### F6 — Session lifetime is a hard 8h cap, not an idle timeout · **informational**

§5. No `EXPIRE` refresh on access. Worth confirming this is the intent before anyone
"fixes" it in either direction.

### F7 — `manual_review` accounts are locked out of the dashboard · **informational**

`sessionAuth` gate 3 requires `status === "active"`. `tripAccountToManualReview`
(`packages/db/src/repositories/accounts.ts`) sets `manual_review`, so an account tripped
by the fraud path loses dashboard access entirely — including the ability to look at
what happened. May well be intended; flagging because it fires on a legitimate customer,
not just an abusive one.

### F8 — Dev proxy env var name doesn't match the documented one · **cosmetic**

`vite.config.ts:8` reads `VITE_API_ORIGIN`. README:584-586 and
`apps/dashboard/Dockerfile:28` document `API_ORIGIN` (nginx, runtime) and `VITE_API_URL`
(build). Setting the documented name in dev silently falls through to the
`http://localhost:3000` default. Dev-only.

---

## 8. What's already right

Recording these so a later pass doesn't re-litigate them:

- Token is `randomBytes(32)`, not `Math.random`, not a JWT (`session.ts:19`).
- `HttpOnly` on both cookies — no page JS can read either.
- Same-origin `/v1` proxy in both dev and prod, so the session never needs `SameSite=None`
  (`vite.config.ts:15`, `nginx.conf.template:23`).
- CORS is scoped to one configured origin with no `credentials: true` (`app.ts:62`).
- Login pays for one argon2 verify against a fixed dummy hash when the account doesn't
  exist or is Google-only, so timing doesn't enumerate emails (`routes/auth.ts:48,154`).
- A failed login sets no cookie at all — asserted, not assumed
  (`phase10-onboarding.integration.test.ts:201`).
- PKCE + `state`, server-side token exchange, secret never reaches the browser.
- No auto-link on matching email in either direction (D1), with the pre-registration
  takeover it prevents spelled out at `auth-google.ts:107` and tested at `:373`.
- Session and API-key auth cover disjoint route sets, enforced by the routing table
  rather than by a shared function's branch.
