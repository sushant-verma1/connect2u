import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import type { Trace } from "../../lib/types";
import { DecisionActionBadge } from "./statusBadges";

/**
 * R3.9/R10.6: this is the log ARCHITECTURE.md §5 describes as "what the dashboard
 * trace view renders" — every channel the policy considered, in the order the pipeline
 * (match → capability filter → score rank → cost ceiling) touched it, and the reason
 * for every skip. Nothing here is recomputed; it's the exact decision the router made.
 */
export function RoutingDecisionCard({
  routingDecision,
}: {
  routingDecision: Trace["routing_decision"];
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Routing decision</CardTitle>
        {routingDecision?.chosen_channel && (
          <span className="text-xs text-slate-500">
            chose <Badge variant="success">{routingDecision.chosen_channel}</Badge>
          </span>
        )}
      </CardHeader>
      <CardContent>
        {!routingDecision || routingDecision.decision_log.length === 0 ? (
          <p className="text-sm text-slate-500">
            No routing decision recorded for this verification.
          </p>
        ) : (
          <ol className="relative space-y-4 border-l border-slate-200 pl-5">
            {routingDecision.decision_log.map((entry, index) => (
              <li key={index} className="relative">
                <span className="absolute -left-[1.45rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-400 ring-1 ring-slate-300" />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    {entry.stage.replace("_", " ")}
                  </span>
                  <DecisionActionBadge action={entry.action} />
                  {entry.channel && <Badge variant="neutral">{entry.channel}</Badge>}
                </div>
                <p className="mt-1 text-sm text-slate-700">{entry.reason}</p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
