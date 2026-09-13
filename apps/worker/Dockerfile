# Built from the repo root: docker build -f apps/worker/Dockerfile .
FROM node:22-slim
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/simulator/package.json packages/simulator/package.json
RUN pnpm config set store-dir /pnpm-store && pnpm install --frozen-lockfile
COPY apps/worker apps/worker
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/providers packages/providers
ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "--filter", "@otp-router/worker", "start"]
