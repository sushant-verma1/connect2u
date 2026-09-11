import { defineConfig } from "drizzle-kit";

// Dev-only CLI config, never imported by application code — matches the
// docker-compose default so `db:generate` works without extra setup.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/otp_router",
  },
});
