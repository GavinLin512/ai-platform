# syntax=docker/dockerfile:1
#
# Build from the repository root:
#   docker build -f apps/dashboard/Dockerfile -t l10n-review-dashboard .

ARG NODE_VERSION=24

# ---- build: install, then `next build` (needs dev dependencies: Tailwind, TypeScript) -------
FROM node:${NODE_VERSION}-alpine AS build
RUN npm install --global pnpm@10.28.0
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY apps/github-app/package.json apps/github-app/
COPY apps/dashboard/package.json apps/dashboard/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/db/src packages/db/src
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @l10n-review/dashboard build

# ---- runtime: Next's standalone server (only the files it traced), as a non-root user -----
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
