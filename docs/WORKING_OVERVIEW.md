# Working Overview

This is the current behavior implemented in `memory-core`.

## Core operations

1. `POST /v1/memory/ingest` - add/update memories
2. `POST /v1/memory/search` - retrieve memories by query + filters
3. `POST /v1/memory/context` - build prompt-ready context block
4. `GET /v1/memory/profile/:tenantId/:appId/:actorId` - actor memory summary
5. `POST /v1/memory/feedback` - quality feedback (`selected|positive|negative`)
6. `POST /v1/memory/compact` - archive expired memory

## Memory flow (step-by-step)

1. App sends observations with identity keys (`tenantId`, `appId`, `actorId`, optional `threadId`).
2. Service normalizes text/summary/confidence/importance/decay policy.
3. Provider duplicate check runs on same actor + memory type + normalized text.
4. If duplicate exists, service updates `lastSeenAt`, merges metadata, and updates record.
5. If new, service creates a memory record and persists via provider.

## Retrieval and context flow (step-by-step)

1. App calls `search` or `context` with filters and query.
2. Provider applies hard filters first (`tenantId`, `appId`, optional actor/thread/type/scope).
3. Ranking happens in provider:
   - `in-memory`: lexical overlap + recency + confidence + importance + feedback boost/penalty
   - `mem0`: semantic retrieval from Mem0 OSS backend
4. Context builder selects top hits within `maxItems` and `maxChars`.
5. Service appends actor profile summary (if `actorId` provided) and returns `contextText`.

## Security and runtime controls

1. Optional API key auth for `/v1/*` using `MEMORY_CORE_API_KEYS`
2. Rate limit per identity using `MEMORY_RATE_LIMIT_PER_MIN`
3. Health endpoints:
   - `GET /health` (liveness)
   - `GET /ready` (provider readiness)

## Providers currently available

1. `in-memory` - fastest baseline, process-local only
2. `file` - JSON persistence on disk
3. `mem0` - Mem0 OSS adapter (`mem0ai/oss`) with local vector store mode in this implementation
