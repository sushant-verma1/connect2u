import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { CodeBlock } from "./CodeBlock";

// The deployed API origin. The dashboard itself reaches the API through a same-origin
// `/v1` proxy (vite.config.ts, nginx.conf.template), but a developer pasting these
// samples into their own terminal has no proxy — they call the API host directly.
const API_BASE_URL = "https://api-production-5885.up.railway.app";

export type DocSection = Readonly<{
  slug: string;
  group: string;
  navLabel: string;
  title: string;
  subtitle: string;
  body: ReactNode;
}>;

function H({ children }: { children: ReactNode }) {
  return <h2 className="text-base font-semibold text-slate-900">{children}</h2>;
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-slate-600">{children}</p>;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-800">
      {children}
    </code>
  );
}

function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 text-sm leading-relaxed",
        tone === "warn"
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-sky-200 bg-sky-50 text-sky-900",
      )}
    >
      {children}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="relative border-l border-slate-200 pl-6">
      <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
        {n}
      </span>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      <div className="mt-3 space-y-3 pb-2">{children}</div>
    </section>
  );
}

function Table({
  head,
  rows,
}: {
  head: readonly string[];
  rows: readonly (readonly ReactNode[])[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            {head.map((cell) => (
              <th key={cell} className="px-3 py-2 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-slate-100 align-top last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-slate-600">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const AUTH_HEADER = `$headers = @{
    Authorization = "Bearer YOUR_API_KEY"
}`;

const START_REQUEST = `${AUTH_HEADER}

Invoke-RestMethod \`
  -Uri "${API_BASE_URL}/v1/verification/start" \`
  -Method POST \`
  -Headers $headers \`
  -ContentType "application/json" \`
  -Body (@{
      phone_number = "YOUR_PHONE_NUMBER"
  } | ConvertTo-Json)`;

const START_RESPONSE = `verification_id   : ver_01J8ZK7Q3M4P5R6S7T8V9W
status            : pending
channel_attempted : whatsapp
expires_at        : 2026-09-19T10:35:00.000Z`;

const CHECK_REQUEST = `Invoke-RestMethod \`
  -Uri "${API_BASE_URL}/v1/verification/check" \`
  -Method POST \`
  -Headers $headers \`
  -ContentType "application/json" \`
  -Body (@{
      verification_id = "YOUR_VERIFICATION_ID"
      code            = "123456"
  } | ConvertTo-Json)`;

const CHECK_RESPONSE = `verification_id  : ver_01J8ZK7Q3M4P5R6S7T8V9W
status           : verified
channel_verified : whatsapp
attempts_used    : 1`;

const START_FULL_BODY = `{
  "phone_number": "YOUR_PHONE_NUMBER",
  "channels": ["whatsapp", "sms"],
  "locale": "en",
  "code_length": 6,
  "ttl_seconds": 300,
  "metadata": { "user_id": "usr_123" }
}`;

const START_RESPONSE_JSON = `{
  "verification_id": "ver_01J8ZK7Q3M4P5R6S7T8V9W",
  "status": "pending",
  "channel_attempted": "whatsapp",
  "expires_at": "2026-09-19T10:35:00.000Z"
}`;

const IDEMPOTENT_HEADER = `$headers = @{
    Authorization     = "Bearer YOUR_API_KEY"
    "Idempotency-Key" = [guid]::NewGuid().ToString()
}`;

const GET_REQUEST = `Invoke-RestMethod \`
  -Uri "${API_BASE_URL}/v1/verification/YOUR_VERIFICATION_ID" \`
  -Headers $headers`;

const POLICY_REQUEST = `Invoke-RestMethod \`
  -Uri "${API_BASE_URL}/v1/accounts/me/routing-policy" \`
  -Headers $headers`;

const POLICY_BODY = `{
  "version": 1,
  "rules": [
    {
      "match": { "country": "IN" },
      "channels": ["whatsapp", "sms"],
      "timeouts_ms": { "whatsapp": 20000, "sms": 30000 }
    }
  ],
  "default": { "channels": ["whatsapp", "sms"] }
}`;

export const DOC_SECTIONS: readonly DocSection[] = [
  {
    slug: "quickstart",
    group: "Getting Started",
    navLabel: "Quickstart",
    title: "Connect2U Quickstart",
    subtitle: "Send your first OTP verification in a few minutes.",
    body: (
      <div className="space-y-8">
        <Step n={1} title="Create your API key">
          <P>Your API key authenticates requests to the Connect2U API.</P>
          <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-slate-600">
            <li>
              Open <strong className="font-medium text-slate-900">API keys</strong> from the
              dashboard.
            </li>
            <li>
              Click <strong className="font-medium text-slate-900">New key</strong>.
            </li>
            <li>Copy the key immediately — it is shown once and never again.</li>
            <li>Store it where only your server can read it, such as an environment variable.</li>
          </ol>
          <Note tone="warn">
            Your API key is a secret. Do not commit it to GitHub, expose it in frontend JavaScript,
            or paste it into public documentation. If a key leaks, revoke it on the API keys page
            and create a new one.
          </Note>
          <Link
            to="/keys"
            className="inline-flex rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Create API key
          </Link>
        </Step>

        <Step n={2} title="Make your first verification request">
          <P>
            Use your API key as a Bearer token. Replace <Code>YOUR_API_KEY</Code> with the key you
            just copied, and <Code>YOUR_PHONE_NUMBER</Code> with a phone number in E.164 format (for
            example <Code>+919876543210</Code>).
          </P>
          <CodeBlock language="powershell" code={START_REQUEST} />
        </Step>

        <Step n={3} title="Read the response">
          <P>
            A successful start returns <Code>202 Accepted</Code>: the message is queued, not yet
            delivered. Delivery happens asynchronously on whichever channel routing picked.
          </P>
          <CodeBlock language="response" code={START_RESPONSE} />
          <Table
            head={["Field", "Meaning"]}
            rows={[
              [
                <Code key="f">verification_id</Code>,
                "Identifies this verification. Keep it — every later call needs it.",
              ],
              [
                <Code key="f">status</Code>,
                <>
                  Always <Code>pending</Code> here. A verification leaves <Code>pending</Code> only
                  when it is verified, expires, or runs out of attempts.
                </>,
              ],
              [
                <Code key="f">channel_attempted</Code>,
                <>
                  The first channel routing chose — <Code>whatsapp</Code> or <Code>sms</Code>. If it
                  stalls, Connect2U falls back on its own.
                </>,
              ],
              [
                <Code key="f">expires_at</Code>,
                <>
                  When the code stops being accepted. Five minutes by default; set{" "}
                  <Code>ttl_seconds</Code> to change it.
                </>,
              ],
            ]}
          />
        </Step>

        <Step n={4} title="Check the code your user entered">
          <P>
            Send the code back with the <Code>verification_id</Code> from step 3.
          </P>
          <CodeBlock language="powershell" code={CHECK_REQUEST} />
          <CodeBlock language="response" code={CHECK_RESPONSE} />
          <Note>
            A wrong code is not an HTTP error. <Code>/v1/verification/check</Code> answers{" "}
            <Code>200</Code> and puts the outcome in <Code>status</Code> — branch on that field, not
            on the status code.
          </Note>
        </Step>

        <div className="border-t border-slate-200 pt-6">
          <H>Next steps</H>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            <li>
              <Link className="font-medium text-slate-900 underline" to="/docs/start-verification">
                Start verification
              </Link>{" "}
              — every request field, plus idempotent retries.
            </li>
            <li>
              <Link className="font-medium text-slate-900 underline" to="/docs/check-verification">
                Check verification
              </Link>{" "}
              — all seven outcomes, and polling instead of prompting.
            </li>
            <li>
              <Link className="font-medium text-slate-900 underline" to="/docs/routing">
                How routing works
              </Link>{" "}
              — why a channel was picked, and how to override it.
            </li>
            <li>
              <Link className="font-medium text-slate-900 underline" to="/docs/errors">
                Errors
              </Link>{" "}
              — status codes, error codes, and rate limits.
            </li>
          </ul>
        </div>
      </div>
    ),
  },
  {
    slug: "api-keys",
    group: "Authentication",
    navLabel: "API Keys",
    title: "API keys",
    subtitle: "How Connect2U authenticates your server.",
    body: (
      <div className="space-y-6">
        <section className="space-y-3">
          <H>Creating a key</H>
          <P>
            API keys are created from the dashboard by a signed-in human — no endpoint mints a key
            from another key. Open the API keys page and click{" "}
            <strong className="font-medium text-slate-900">New key</strong>.
          </P>
          <P>
            A key looks like <Code>sk_test_a1b2c3d4.&lt;secret&gt;</Code>. Only the{" "}
            <Code>sk_test_a1b2c3d4</Code> prefix is stored readably; the rest is hashed, so the full
            key is shown exactly once, at creation.
          </P>
          <Note tone="warn">
            Your API key is a secret. Do not commit it to GitHub, expose it in frontend JavaScript,
            or paste it into public documentation.
          </Note>
          <Link
            to="/keys"
            className="inline-flex rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Create API key
          </Link>
        </section>

        <section className="space-y-3">
          <H>Using a key</H>
          <P>
            Send it as a Bearer token on every <Code>/v1/verification/*</Code> and{" "}
            <Code>/v1/accounts/me/*</Code> request. A missing, malformed, or revoked key returns{" "}
            <Code>401</Code> with <Code>{`{ "error": "unauthorized" }`}</Code>.
          </P>
          <CodeBlock language="powershell" code={AUTH_HEADER} />
        </section>

        <section className="space-y-3">
          <H>Revoking a key</H>
          <P>
            Revoke on the API keys page. Revocation is immediate on the server instance that handled
            it, but another instance can keep honouring the key for up to 30 seconds — verified keys
            are cached that long so the deliberately slow hash check stays off the hot path.
          </P>
        </section>

        <section className="space-y-3">
          <H>Keys are not sessions</H>
          <P>
            The two credentials are deliberately disjoint. An API key authenticates the verification
            API and nothing else; your dashboard session cookie authenticates the dashboard and
            nothing else. A session cannot call <Code>/v1/verification/start</Code>, and an API key
            cannot manage keys.
          </P>
        </section>
      </div>
    ),
  },
  {
    slug: "start-verification",
    group: "Verification",
    navLabel: "Start Verification",
    title: "Start verification",
    subtitle: "POST /v1/verification/start",
    body: (
      <div className="space-y-6">
        <P>
          Generates a code, picks a channel, and queues delivery. Answers <Code>202 Accepted</Code>{" "}
          once the send is queued — not once it is delivered. The code itself is never returned by
          any endpoint.
        </P>

        <section className="space-y-3">
          <H>Request body</H>
          <Table
            head={["Field", "Type", "Required", "Notes"]}
            rows={[
              [
                <Code key="f">phone_number</Code>,
                "string",
                "Yes",
                "E.164, e.g. +919876543210. Rejected as invalid_phone_number if it cannot be normalised.",
              ],
              [
                <Code key="f">channels</Code>,
                <Code key="t">{`("whatsapp" | "sms")[]`}</Code>,
                "No",
                <>
                  Restricts the chain routing may use. Omit it to let routing decide; the default
                  chain is <Code>["whatsapp", "sms"]</Code>.
                </>,
              ],
              [<Code key="f">locale</Code>, "string", "No", "Passed through to the template."],
              [<Code key="f">code_length</Code>, "integer", "No", "4–8. Defaults to 6."],
              [
                <Code key="f">ttl_seconds</Code>,
                "integer",
                "No",
                "60–900. Defaults to 300 (5 minutes).",
              ],
              [
                <Code key="f">metadata</Code>,
                "object",
                "No",
                "Returned again on check. Max 4096 bytes serialised, else metadata_too_large.",
              ],
            ]}
          />
          <CodeBlock language="json" code={START_FULL_BODY} />
        </section>

        <section className="space-y-3">
          <H>Idempotent retries</H>
          <P>
            Send an <Code>Idempotency-Key</Code> header and a retried request replays the original
            response instead of sending a second message — even if both requests arrive at the same
            instant.
          </P>
          <CodeBlock language="powershell" code={IDEMPOTENT_HEADER} />
        </section>

        <section className="space-y-3">
          <H>Response — 202</H>
          <CodeBlock language="json" code={START_RESPONSE_JSON} />
          <P>
            Failures return <Code>401</Code>, <Code>403</Code>, <Code>422</Code>, or{" "}
            <Code>429</Code> — see{" "}
            <Link className="font-medium text-slate-900 underline" to="/docs/errors">
              Errors
            </Link>
            .
          </P>
        </section>
      </div>
    ),
  },
  {
    slug: "check-verification",
    group: "Verification",
    navLabel: "Check Verification",
    title: "Check verification",
    subtitle: "POST /v1/verification/check",
    body: (
      <div className="space-y-6">
        <P>
          Submits the code your user typed. An authenticated request always answers <Code>200</Code>{" "}
          — the outcome is in <Code>status</Code>, so branch on that rather than on the HTTP status
          code.
        </P>
        <CodeBlock language="powershell" code={CHECK_REQUEST} />

        <section className="space-y-3">
          <H>Outcomes</H>
          <Table
            head={["status", "Meaning"]}
            rows={[
              [
                <Code key="s">verified</Code>,
                <>
                  Correct code. <Code>channel_verified</Code> names the channel it arrived on, or is{" "}
                  <Code>null</Code> when that could not be attributed.
                </>,
              ],
              [
                <Code key="s">invalid_code</Code>,
                <>
                  Wrong code, verification still open. <Code>attempts_used</Code> against{" "}
                  <Code>max_attempts</Code> (5) tells you how close the user is to the limit.
                </>,
              ],
              [
                <Code key="s">expired</Code>,
                <>
                  Past <Code>expires_at</Code>. Start a new verification.
                </>,
              ],
              [
                <Code key="s">already_verified</Code>,
                "This verification was already completed. Not an error — treat it as success if you are retrying.",
              ],
              [
                <Code key="s">attempts_exceeded</Code>,
                "Too many wrong codes; the verification is burned. Start a new one.",
              ],
              [<Code key="s">not_found</Code>, "No verification with that id on your account."],
              [<Code key="s">failed</Code>, "Every channel in the chain failed to deliver."],
            ]}
          />
        </section>

        <section className="space-y-3">
          <H>Polling instead of prompting</H>
          <P>
            <Code>GET /v1/verification/:id</Code> returns the current status,{" "}
            <Code>attempts_used</Code>, <Code>max_attempts</Code>, and <Code>expires_at</Code>{" "}
            without submitting a code.
          </P>
          <CodeBlock language="powershell" code={GET_REQUEST} />
        </section>

        <section className="space-y-3">
          <H>Seeing what happened</H>
          <P>
            <Code>GET /v1/verification/:id/trace</Code> returns the whole story of one verification:
            every delivery attempt, every provider webhook, the channel chain, the timeouts, and the
            routing decision log explaining why each channel was chosen or skipped. The dashboard's
            Trace page reads the same data.
          </P>
          <Link
            to="/trace"
            className="inline-flex rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Open Trace
          </Link>
        </section>
      </div>
    ),
  },
  {
    slug: "routing",
    group: "Routing",
    navLabel: "How Routing Works",
    title: "How routing works",
    subtitle: "Why a verification went out on the channel it did.",
    body: (
      <div className="space-y-6">
        <P>
          You never name a provider. Every start builds a routing plan — an ordered chain of
          channels — and sends on the first one. If that channel produces no verification before its
          timeout, the next channel in the chain is tried.
        </P>

        <section className="space-y-3">
          <H>The four stages</H>
          <Table
            head={["Stage", "What it does"]}
            rows={[
              [
                <Code key="s">match_policy</Code>,
                "Takes the first policy rule matching this request's country, prefix, risk, or metadata, and reads its channels, timeouts, and cost ceiling from it. If no rule matches, the policy default applies.",
              ],
              [
                <Code key="s">capability_filter</Code>,
                "Drops channels that cannot serve this number right now — for example a provider currently recorded as degraded.",
              ],
              [
                <Code key="s">score_rank</Code>,
                "Orders what is left by measured verification rate (not delivery rate), tie-broken on median time-to-verify. A channel with no history yet ranks as an average performer.",
              ],
              [
                <Code key="s">cost_ceiling</Code>,
                "Drops channels whose captured send rate exceeds the rule's max_cost_micros, then caps the chain length.",
              ],
            ]}
          />
          <P>
            Each stage writes a line into the verification's decision log, including the reason a
            channel was skipped. That log is what <Code>GET /v1/verification/:id/trace</Code>{" "}
            returns.
          </P>
        </section>

        <section className="space-y-3">
          <H>Fallback and the shared code</H>
          <P>
            Default timeouts are 20 seconds for WhatsApp and 30 for SMS: below roughly 15 seconds
            you double-send constantly and pay twice; above 30 the user has already given up. A
            chain is capped at three channels.
          </P>
          <Note>
            One code per verification, shared across every channel. A fallback re-sends the same
            code on a different channel — whichever message the user reads, the code they type
            works.
          </Note>
        </section>

        <section className="space-y-3">
          <H>Overriding routing</H>
          <P>
            Read your active policy with <Code>GET /v1/accounts/me/routing-policy</Code>. Until you
            set one, it returns the default policy with <Code>version: 0</Code>.
          </P>
          <CodeBlock language="powershell" code={POLICY_REQUEST} />
          <P>
            <Code>PUT</Code> the same path to activate a new version. Rules are evaluated in order,
            an omitted <Code>match</Code> key is a wildcard, and a <Code>default</Code> outcome is
            required.
          </P>
          <CodeBlock language="json" code={POLICY_BODY} />
          <P>
            Activating a policy is a plain database write — no deploy, no restart. For a single
            request, <Code>channels</Code> on the start body is the lighter override.
          </P>
        </section>
      </div>
    ),
  },
  {
    slug: "errors",
    group: "Reference",
    navLabel: "Errors",
    title: "Errors",
    subtitle: "Status codes, error codes, and rate limits.",
    body: (
      <div className="space-y-6">
        <P>
          Errors are JSON with a single stable <Code>error</Code> field:{" "}
          <Code>{`{ "error": "invalid_phone_number" }`}</Code>. Match on that string, not on a
          message.
        </P>

        <section className="space-y-3">
          <H>Error codes</H>
          <Table
            head={["HTTP", "error", "Cause and fix"]}
            rows={[
              [
                "401",
                <Code key="e">unauthorized</Code>,
                "Missing, malformed, or revoked API key, or a suspended account. Check the Authorization header carries Bearer plus the full key, including the part after the dot.",
              ],
              [
                "403",
                <Code key="e">account_under_review</Code>,
                "A fraud signal moved your account to manual review. Later requests are rejected too until it is cleared.",
              ],
              [
                "404",
                <Code key="e">not_found</Code>,
                "No verification with that id on your account. Note that check reports the same situation as status not_found with HTTP 200.",
              ],
              [
                "422",
                <Code key="e">invalid_phone_number</Code>,
                "phone_number could not be normalised. Send E.164, including the country code.",
              ],
              [
                "422",
                <Code key="e">metadata_too_large</Code>,
                "Serialised metadata exceeded 4096 bytes.",
              ],
              [
                "422",
                <Code key="e">no_channel_available</Code>,
                "Routing had nothing left after filtering — every candidate channel was unavailable or priced out by the policy's cost ceiling.",
              ],
              [
                "429",
                <Code key="e">rate_limited_number</Code>,
                "More than 5 starts for one phone number in 10 minutes.",
              ],
              [
                "429",
                <Code key="e">rate_limited_account</Code>,
                "More than 100 starts on your account in one minute.",
              ],
              [
                "429",
                <Code key="e">rate_limited_ip</Code>,
                "More than 20 starts from one IP in one minute.",
              ],
            ]}
          />
        </section>

        <section className="space-y-3">
          <H>Retries</H>
          <P>
            Every <Code>429</Code> carries a <Code>Retry-After</Code> header in seconds — wait that
            long rather than backing off blindly. When retrying a start after a network error, send
            the same <Code>Idempotency-Key</Code> so the retry replays the original response instead
            of sending a second message.
          </P>
        </section>

        <section className="space-y-3">
          <H>Not errors</H>
          <P>
            A wrong code, an expired verification, and an exhausted attempt budget all return{" "}
            <Code>200</Code> from <Code>/v1/verification/check</Code> with the outcome in{" "}
            <Code>status</Code>. See{" "}
            <Link className="font-medium text-slate-900 underline" to="/docs/check-verification">
              Check verification
            </Link>
            .
          </P>
        </section>
      </div>
    ),
  },
];
