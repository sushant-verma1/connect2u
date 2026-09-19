import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "./lib/cn";
import { useAuth } from "./lib/AuthContext";

const NAV_ITEMS = [
  { to: "/keys", label: "Keys" },
  { to: "/trace", label: "Trace" },
];

/** Inline rather than a lucide-react dependency — one icon does not earn a package
 * (TECHSTACK.md). Traced from lucide's `book-open`. */
function BookOpenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { auth, logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold tracking-tight text-slate-900">otp-router</p>
          <p className="text-xs text-slate-500">dashboard</p>
        </div>
        {auth.status === "authenticated" && (
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

            {/* Set apart from the analytics screens above it: Docs is a reference
                surface, not another view onto this account's data. */}
            <NavLink
              to="/docs"
              className={({ isActive }) =>
                cn(
                  "mt-2 flex items-center gap-2 border-t border-slate-100 px-3 pb-2 pt-3 text-sm font-medium",
                  isActive ? "text-slate-900" : "text-slate-600 hover:text-slate-900",
                )
              }
            >
              <BookOpenIcon />
              Docs
            </NavLink>
          </nav>
        )}
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-6 py-3">
          {auth.status === "authenticated" && (
            <>
              <span className="text-xs text-slate-500">{auth.account.email}</span>
              <button
                onClick={() => void logout()}
                className="rounded-md px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                Log out
              </button>
            </>
          )}
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
