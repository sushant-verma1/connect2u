import type { ReactNode } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Layout } from "./Layout";
import { useAuth } from "./lib/AuthContext";
import { HomePage } from "./pages/HomePage";
import { SignupPage } from "./pages/SignupPage";
import { LoginPage } from "./pages/LoginPage";
import { KeysPage } from "./pages/KeysPage";
import { TracePage } from "./pages/TracePage";
import { DocsPage } from "./pages/docs/DocsPage";
import { RoutingDemoPage } from "./pages/demo/RoutingDemoPage";

/** R13.2: the dashboard's side of "replace the localStorage key field with the
 * session" — every route below this gate needs `GET /v1/auth/me` to have resolved to
 * an account, same as the API's `sessionAuth` hook gates its own routes. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { auth } = useAuth();
  if (auth.status === "loading") return null;
  if (auth.status === "anonymous") return <Navigate to="/login" replace />;
  return children;
}

/** The public homepage is the one route that is not a dashboard surface, so `Layout`
 * (sidebar, account header) moves from wrapping every route to being a layout route
 * the rest of them sit under. */
function DashboardLayout() {
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route element={<DashboardLayout />}>
        {/* /demo/routing replaces the old /demo page — this redirect keeps any
            already-shared /demo link working. */}
        <Route path="/demo" element={<Navigate to="/demo/routing" replace />} />
        <Route path="/demo/routing" element={<RoutingDemoPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/keys"
          element={
            <RequireAuth>
              <KeysPage />
            </RequireAuth>
          }
        />
        <Route
          path="/trace"
          element={
            <RequireAuth>
              <TracePage />
            </RequireAuth>
          }
        />
        <Route
          path="/trace/:id"
          element={
            <RequireAuth>
              <TracePage />
            </RequireAuth>
          }
        />
        {/* /docs opens Quickstart — the section list lives in pages/docs/sections.tsx,
            so this route stays one entry regardless of how many sections exist. */}
        <Route path="/docs" element={<Navigate to="/docs/quickstart" replace />} />
        <Route
          path="/docs/:section"
          element={
            <RequireAuth>
              <DocsPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/keys" replace />} />
      </Route>
    </Routes>
  );
}
