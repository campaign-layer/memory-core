# memory-core — multi-stage build.
#
# The previous version ran `npm ci --only=production` and then `npm run build`,
# which cannot work: typescript, @types/node and @types/express are
# devDependencies, so tsc was not installed when the build ran.
#
# Base is Debian slim, not Alpine: the opt-in local ONNX dependency pulls in
# native onnxruntime-node and sharp binaries that target glibc.

# --- stage 1: compile ---------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Full development install so tsc exists, but no optional ONNX stack is needed
# to compile the deliberately dynamic import in LocalOnnxEmbedder.
COPY package.json package-lock.json ./
RUN npm ci --omit=optional

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- stage 2: runtime dependencies -------------------------------------------
# Separate stage so the runtime image never sees typescript, tsx or @types/*.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# The production image is BM25/hosted-embedder capable by default. Local ONNX
# is an explicit opt-in because its native dependency tree is large and must be
# independently vulnerability-gated before release.
ARG MEMORY_CORE_INCLUDE_LOCAL_ONNX=false
RUN if [ "$MEMORY_CORE_INCLUDE_LOCAL_ONNX" = "true" ]; then \
      npm ci --omit=dev; \
    else \
      npm ci --omit=dev --omit=optional; \
    fi \
    && npm cache clean --force

# --- stage 3: runtime ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# Normal images remain buildable without provenance arguments. The qualification
# Compose file supplies exact object IDs, and its controller rejects `unknown`.
ARG MEMORY_CORE_BUILD_REVISION=unknown
ARG MEMORY_CORE_BUILD_SOURCE_TREE=unknown
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# PostgresMemoryProvider resolves migrations/001_init.sql relative to its own
# compiled location (dist/providers/../../migrations), so it must ship.
COPY migrations ./migrations

# The file provider writes to MEMORY_FILE_PATH, default ./data/memory-core.json,
# and the image runs unprivileged. Mount a volume here to persist across runs.
RUN mkdir -p /app/data \
    && chown -R node:node /app/data \
    && if [ "$MEMORY_CORE_BUILD_REVISION" != "unknown" ]; then \
         test "${#MEMORY_CORE_BUILD_REVISION}" -eq 40 \
         && test -z "$(printf '%s' "$MEMORY_CORE_BUILD_REVISION" | tr -d '0-9a-f')"; \
       fi \
    && if [ "$MEMORY_CORE_BUILD_SOURCE_TREE" != "unknown" ]; then \
         test "${#MEMORY_CORE_BUILD_SOURCE_TREE}" -eq 40 \
         && test -z "$(printf '%s' "$MEMORY_CORE_BUILD_SOURCE_TREE" | tr -d '0-9a-f')"; \
       fi
LABEL org.opencontainers.image.revision="${MEMORY_CORE_BUILD_REVISION}" \
      io.memory-core.source-tree="${MEMORY_CORE_BUILD_SOURCE_TREE}"
USER node

EXPOSE 7401

# node:22 has global fetch, so no curl/wget is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7401)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, not `npm start`: src/server.ts installs SIGTERM/SIGINT handlers to
# close the provider (pg pool, timers), and npm would not forward the signal.
CMD ["node", "dist/server.js"]
