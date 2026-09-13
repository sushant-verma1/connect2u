import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "otp-router-dashboard-api-key";

type ApiKeyContextValue = readonly [string, (key: string) => void];

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

/**
 * Every route this dashboard reads is Bearer-authenticated (R8.1) — there's no
 * separate dashboard session, so the same account API key used elsewhere is what
 * unlocks its own trace data here. Kept in localStorage only, never sent anywhere but
 * this API. A context, not a per-component `useState`, because the key is entered once
 * in the header (Layout) but read from wherever a page needs it (TracePage) — two
 * independent `useState`s initialized from the same localStorage key would each hold
 * their own copy and silently drift the moment one of them changes.
 */
export function ApiKeyProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKeyState] = useState(() => localStorage.getItem(STORAGE_KEY) ?? "");

  const setApiKey = useCallback((key: string) => {
    localStorage.setItem(STORAGE_KEY, key);
    setApiKeyState(key);
  }, []);

  const value = useMemo(() => [apiKey, setApiKey] as const, [apiKey, setApiKey]);

  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>;
}

export function useApiKey(): ApiKeyContextValue {
  const context = useContext(ApiKeyContext);
  if (!context) throw new Error("useApiKey must be used within an ApiKeyProvider");
  return context;
}
