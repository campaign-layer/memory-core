# memory-core — multi-stage build.
#
# The previous version ran `npm ci --only=production` and then `npm run build`,
# which cannot work: typescript, @types/node and @types/express are
# devDependencies, so tsc was not installed when the build ran.
#
# Base is Debian slim, not Alpine: `@huggingface/transformers` (a runtime
# dependency) pulls in onnxruntime-node and sharp, whose prebuilt binaries are
# glibc-linked. Alpine/musl would install and then fail at require time.

# --- stage 1: compile ---------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Full install (devDependencies included) so tsc exists.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- stage 2: runtime dependencies -------------------------------------------
# Separate stage so the runtime image never sees typescript, tsx or @types/*.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- stage 3: runtime ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
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
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 7401

# node:22 has global fetch, so no curl/wget is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7401)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, not `npm start`: src/server.ts installs SIGTERM/SIGINT handlers to
# close the provider (pg pool, timers), and npm would not forward the signal.
CMD ["node", "dist/server.js"]
