import { type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchTrace, ApiError } from "../lib/api";
import { useApiKey } from "../lib/ApiKeyContext";
import { Card, CardContent } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { VerificationSummaryCard } from "./trace/VerificationSummaryCard";
import { RoutingDecisionCard } from "./trace/RoutingDecisionCard";
import { AttemptsTimeline } from "./trace/AttemptsTimeline";

// R10.7: 10s polling — but only while the verification is still in flight. A terminal
// trace (verified/expired/burned/failed) can't change, so refetching it every 10s
// forever would just be load with no new information; this is the same "poll while
// there's something to learn" reasoning behind Phase 3's fallback timer only existing
// once a send has actually happened.
const POLL_INTERVAL_MS = 10_000;

function SearchBar({ initialId }: { initialId: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState(initialId);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) navigate(`/trace/${encodeURIComponent(value.trim())}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="ver_01J..."
        className="w-80 rounded-md border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
      />
      <button
        type="submit"
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        Load trace
      </button>
    </form>
  );
}

function TraceSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function TracePage() {
  const { id } = useParams<{ id: string }>();
  const [apiKey] = useApiKey();

  const query = useQuery({
    queryKey: ["trace", id, apiKey],
    queryFn: () => fetchTrace(id as string, apiKey),
    enabled: Boolean(id && apiKey),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? POLL_INTERVAL_MS : false),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="mb-3 text-lg font-semibold text-slate-900">Single-verification trace</h1>
        <SearchBar initialId={id ?? ""} />
      </div>

      {!apiKey && (
        <Card>
          <CardContent className="text-sm text-slate-600">
            Enter an API key in the top-right corner to load a trace.
          </CardContent>
        </Card>
      )}

      {apiKey && !id && (
        <Card>
          <CardContent className="text-sm text-slate-600">
            Paste a verification ID above — it's the <code>verification_id</code> returned by{" "}
            <code>POST /v1/verification/start</code>.
          </CardContent>
        </Card>
      )}

      {apiKey && id && query.isPending && <TraceSkeleton />}

      {apiKey && id && query.isError && (
        <Card>
          <CardContent className="text-sm text-rose-600">
            {query.error instanceof ApiError && query.error.status === 404
              ? "No verification with that ID for this account."
              : `Failed to load trace: ${query.error.message}`}
          </CardContent>
        </Card>
      )}

      {query.data && (
        <div className="space-y-4">
          <VerificationSummaryCard trace={query.data} />
          <RoutingDecisionCard routingDecision={query.data.routing_decision} />
          <AttemptsTimeline attempts={query.data.attempts} />
        </div>
      )}
    </div>
  );
}
