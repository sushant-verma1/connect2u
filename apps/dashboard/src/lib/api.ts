import type { Trace } from "./types";

// R1.1.5-adjacent for the dashboard side: no BFF (ARCHITECTURE.md) — the browser calls
// this API directly, over CORS (apps/api/src/app.ts's DASHBOARD_ORIGIN).
const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiFetch<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
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

export function fetchTrace(verificationId: string, apiKey: string): Promise<Trace> {
  return apiFetch<Trace>(`/v1/verification/${encodeURIComponent(verificationId)}/trace`, apiKey);
}
