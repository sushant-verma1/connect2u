import { type FormEvent, useState } from "react";
import { useNavigate, Navigate, Link } from "react-router-dom";
import { signup, googleSignInUrl, ApiError } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export function SignupPage() {
  const navigate = useNavigate();
  const { auth, refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (auth.status === "authenticated" && !apiKey) {
    return <Navigate to="/keys" replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await signup(email, password);
      refresh();
      // The key is shown exactly once (R13.1) — held here until the person leaves this
      // page, not persisted anywhere, not re-fetchable afterwards.
      setApiKey(result.api_key);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  if (apiKey) {
    return (
      <div className="mx-auto max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>Your API key</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-600">
            <p>
              This is shown <strong>once</strong>. Copy it now — it won't be shown again, only its
              prefix will be visible from the keys page afterwards.
            </p>
            <code className="block break-all rounded-md bg-slate-100 p-3 font-mono text-xs text-slate-900">
              {apiKey}
            </code>
            <button
              onClick={() => navigate("/keys")}
              className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Continue to keys
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Create an account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
            />
            <input
              type="password"
              required
              minLength={8}
              placeholder="Password (min. 8 characters)"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
            />
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {submitting ? "Creating account…" : "Sign up"}
            </button>
          </form>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <div className="h-px flex-1 bg-slate-200" />
            or
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <a
            href={googleSignInUrl()}
            className="block w-full rounded-md border border-slate-300 px-4 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Sign in with Google
          </a>

          <p className="text-center text-xs text-slate-500">
            Already have an account?{" "}
            <Link to="/login" className="font-medium text-slate-700 underline">
              Log in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
