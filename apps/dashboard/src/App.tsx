import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./Layout";
import { TracePage } from "./pages/TracePage";

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/trace" element={<TracePage />} />
        <Route path="/trace/:id" element={<TracePage />} />
        <Route path="*" element={<Navigate to="/trace" replace />} />
      </Routes>
    </Layout>
  );
}
