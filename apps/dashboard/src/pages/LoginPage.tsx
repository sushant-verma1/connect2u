import { type FormEvent, useState } from "react";
import { useNavigate, Navigate, Link } from "react-router-dom";
import { login, googleSignInUrl, ApiError } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export function LoginPage() {
  const navigate = useNavigate();
  const { auth, refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (auth.status === "authenticated") {
    return <Navigate to="/keys" replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      refresh();
      navigate("/keys");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? "Too many attempts — try again in a few minutes."
          : "Incorrect email or password.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Log in</CardTitle>
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
              placeholder="Password"
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
              {submitting ? "Logging in…" : "Log in"}
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
            Don't have an account?{" "}
            <Link to="/signup" className="font-medium text-slate-700 underline">
              Sign up
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
