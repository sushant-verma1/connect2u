import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "./lib/cn";
import { useApiKey } from "./lib/ApiKeyContext";

const NAV_ITEMS = [{ to: "/trace", label: "Trace" }];

export function Layout({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useApiKey();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold tracking-tight text-slate-900">otp-router</p>
          <p className="text-xs text-slate-500">dashboard</p>
        </div>
        <nav className="flex flex-col gap-0.5 p-3">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-2 text-sm font-medium",
                  isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-6 py-3">
          <label className="flex items-center gap-2 text-xs text-slate-500">
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk_test_..."
              className="w-64 rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
            />
          </label>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
