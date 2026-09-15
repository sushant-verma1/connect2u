import type { Trace } from "./types";

// R13.2/B2 (report): relative paths, not an absolute API origin — the dashboard and
// API must be same-origin for the `sid` cookie's SameSite=Lax to be sent at all.
// vite.config.ts proxies `/v1` in dev; nginx.conf.template does the same in prod.
const API_BASE_URL = "";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiFetch<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: init?.method ?? "GET",
    // Same-origin is fetch's own default, but explicit here: this is the one thing
    // that makes the whole session model work, worth stating rather than relying on
    // a default a reader has to already know.
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message =
      body !== null && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : res.statusText;
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export type Account = { account_id: string; email: string };

export function fetchMe(): Promise<Account> {
  return apiFetch<Account>("/v1/auth/me");
}

export function signup(email: string, password: string): Promise<Account & { api_key: string }> {
  return apiFetch("/v1/auth/signup", { method: "POST", body: { email, password } });
}

export function login(email: string, password: string): Promise<Account> {
  return apiFetch("/v1/auth/login", { method: "POST", body: { email, password } });
}

export function logout(): Promise<{ ok: true }> {
  return apiFetch("/v1/auth/logout", { method: "POST" });
}

/** Not a fetch — a full top-level navigation, so the browser actually follows Google's
 * redirect chain and carries the `oauth_tx` cookie PKCE/state depend on. */
export function googleSignInUrl(): string {
  return "/v1/auth/google";
}

export type ApiKey = {
  id: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
};

export function listKeys(): Promise<{ keys: ApiKey[] }> {
  return apiFetch("/v1/keys");
}

export function createKey(): Promise<ApiKey & { api_key: string }> {
  return apiFetch("/v1/keys", { method: "POST" });
}

export function revokeKey(id: string): Promise<{ revoked: true; cache_ttl_seconds: number }> {
  return apiFetch(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// R13.2: the session-authenticated twin of GET /v1/verification/:id/trace — a session
// can never call the API-key-only route, so the dashboard hits this one instead.
export function fetchTrace(verificationId: string): Promise<Trace> {
  return apiFetch<Trace>(`/v1/dashboard/verifications/${encodeURIComponent(verificationId)}/trace`);
}
