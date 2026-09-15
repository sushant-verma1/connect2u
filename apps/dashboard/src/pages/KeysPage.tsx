import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listKeys, createKey, revokeKey } from "../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "never";
}

export function KeysPage() {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revokedNotice, setRevokedNotice] = useState(false);

  const query = useQuery({ queryKey: ["keys"], queryFn: listKeys });

  const createMutation = useMutation({
    mutationFn: createKey,
    onSuccess: (result) => {
      setNewKey(result.api_key);
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: revokeKey,
    onSuccess: () => {
      setRevokedNotice(true);
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">API keys</h1>
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {createMutation.isPending ? "Creating…" : "New key"}
        </button>
      </div>

      {newKey && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="space-y-2 text-sm">
            <p className="font-medium text-emerald-900">
              New key created — shown once, copy it now:
            </p>
            <code className="block break-all rounded-md bg-white p-3 font-mono text-xs text-slate-900">
              {newKey}
            </code>
            <button onClick={() => setNewKey(null)} className="text-xs text-emerald-700 underline">
              Dismiss
            </button>
          </CardContent>
        </Card>
      )}

      {/* R13.5 (report): revoking is immediate on whichever server instance handled
          the request, but a multi-instance deployment can keep honouring the key on
          another instance for up to this long — surfaced here instead of left for
          someone to discover the hard way. */}
      {revokedNotice && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="text-sm text-amber-900">
            Key revoked. It may still work on another server instance for up to 30 seconds.
            <button onClick={() => setRevokedNotice(false)} className="ml-2 text-xs underline">
              Dismiss
            </button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Active keys</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isPending && <Skeleton className="h-24 w-full" />}
          {query.isError && <p className="text-sm text-rose-600">Failed to load keys.</p>}
          {query.data && query.data.keys.length === 0 && (
            <p className="text-sm text-slate-500">No active keys yet.</p>
          )}
          {query.data && query.data.keys.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2">Prefix</th>
                  <th className="py-2">Created</th>
                  <th className="py-2">Last used</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {query.data.keys.map((key) => (
                  <tr key={key.id} className="border-b border-slate-50">
                    <td className="py-2 font-mono text-xs text-slate-900">{key.prefix}</td>
                    <td className="py-2 text-slate-600">{formatDate(key.created_at)}</td>
                    <td className="py-2 text-slate-600">{formatDate(key.last_used_at)}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => revokeMutation.mutate(key.id)}
                        disabled={revokeMutation.isPending}
                        className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
