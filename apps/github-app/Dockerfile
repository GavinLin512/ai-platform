# syntax=docker/dockerfile:1
#
# Build from the repository root (the app needs the workspace packages):
#   docker build -f apps/github-app/Dockerfile -t l10n-review-github-app .

ARG NODE_VERSION=24

# ---- build: install production dependencies, then copy the source -------------------------
FROM node:${NODE_VERSION}-alpine AS build
RUN npm install --global pnpm@10.28.0
WORKDIR /app

# Manifests first: this layer (the slow install) is reused until a dependency changes,
# not every time a source file does.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/ai/package.json packages/ai/
COPY apps/github-app/package.json apps/github-app/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@l10n-review/github-app..."

# There is no compile step: Node runs the TypeScript sources directly.
COPY packages/core/src packages/core/src
COPY packages/ai/src packages/ai/src
COPY packages/db/src packages/db/src
COPY packages/db/drizzle packages/db/drizzle
COPY apps/github-app/src apps/github-app/src

# ---- runtime: only what the app needs, as a non-root user ---------------------------------
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
# COPY keeps pnpm's symlinks (node_modules/@l10n-review/core → packages/core), so Node still
# resolves workspace packages to real paths outside node_modules and can type-strip them.
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "apps/github-app/src/index.ts"]
