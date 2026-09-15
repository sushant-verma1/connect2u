import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, fetchMe, logout as apiLogout, type Account } from "./api";

/**
 * R13.2: replaces the old localStorage API key — the dashboard now holds no
 * credential of its own at all. `GET /v1/auth/me` is the one source of truth for "is
 * there a session"; everywhere else in the app reads it from here instead of each
 * page re-deciding what an absent session means.
 */
type AuthState =
  { status: "loading" } | { status: "anonymous" } | { status: "authenticated"; account: Account };

const AuthContext = createContext<{
  auth: AuthState;
  refresh: () => void;
  logout: () => Promise<void>;
} | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    retry: false,
    // A 401 here just means "not logged in" — not a transient failure worth React
    // Query's usual retry/backoff treatment.
    throwOnError: (error) => !(error instanceof ApiError && error.status === 401),
  });

  const auth: AuthState = query.isLoading
    ? { status: "loading" }
    : query.data
      ? { status: "authenticated", account: query.data }
      : { status: "anonymous" };

  async function logout() {
    await apiLogout();
    await queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <AuthContext.Provider
      value={{ auth, refresh: () => queryClient.invalidateQueries({ queryKey: ["me"] }), logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
