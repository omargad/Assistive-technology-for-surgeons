# syntax=docker/dockerfile:1
#
# SurgeonPulse research ingest server.
#
# Build from the REPOSITORY ROOT (the server depends on the packages/core workspace):
#   docker build -f apps/server/Dockerfile -t surgeonpulse-server .
# Multi-architecture (node:22-alpine is published for amd64 and arm64, e.g. Apple silicon, AWS Graviton,
# Raspberry Pi 4/5):
#   docker buildx build --platform linux/amd64,linux/arm64 -f apps/server/Dockerfile -t <registry>/surgeonpulse-server .
# Run (generate the token once and keep it in a secret store):
#   docker run -d --name surgeonpulse -p 127.0.0.1:8787:8787 -e ADMIN_TOKEN=... -v surgeonpulse-data:/data surgeonpulse-server

ARG NODE_IMAGE=node:22-alpine

# --- build: install the server workspace and bundle it with esbuild ------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /repo

# Manifests first for layer caching. Every workspace manifest is copied so the lockfile matches.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --workspace @surgeonpulse/server --ignore-scripts --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/core/src packages/core/src
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/scripts apps/server/scripts
RUN npm run build --workspace @surgeonpulse/server

# --- runtime: just Node and the self-contained bundle (no node_modules, no compilers) ------------------------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

WORKDIR /app
COPY --from=build /repo/apps/server/package.json ./package.json
COPY --from=build /repo/apps/server/dist ./dist

# Research data lives on a volume owned by the unprivileged "node" user (uid 1000), mode 0700.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# main.js closes gracefully on SIGTERM (finishes in-flight requests, closes SQLite).
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
