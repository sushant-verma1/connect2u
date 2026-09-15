import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// R13.2/B2 (report): the dashboard and API must be same-origin for the session
// cookie's SameSite=Lax to be sent at all — a Vite dev proxy for `/v1` (mirrored in
// prod by nginx.conf.template) makes that true in both places, instead of weakening
// the cookie to SameSite=None to cross an origin boundary that doesn't need to exist.
const API_ORIGIN = process.env.VITE_API_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: API_ORIGIN, changeOrigin: true },
    },
  },
});
