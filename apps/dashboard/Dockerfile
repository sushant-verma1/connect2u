# ---------- Build ----------
FROM node:22-slim AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable

# Copy workspace manifests first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Every workspace manifest, and only the manifests — pnpm-workspace.yaml globs all of
# apps/* and packages/*, and --frozen-lockfile fails if any of them are missing. Copying
# sources here instead would invalidate the install layer on every code change.
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/simulator/package.json packages/simulator/package.json

RUN pnpm install --frozen-lockfile

# Vite inlines import.meta.env.VITE_* at build time, so this has to be present here —
# setting it at runtime does nothing. Pass it as a Railway build variable.
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

# Copy dashboard source
COPY apps/dashboard ./apps/dashboard

# Build dashboard
RUN pnpm --filter @otp-router/dashboard build


# ---------- Serve ----------
FROM nginx:alpine

COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html

# The stock default server also listens on 80; ours replaces it.
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/dashboard/nginx.conf.template /etc/nginx/templates/default.conf.template

# Railway overrides this at runtime.
ENV PORT=80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
