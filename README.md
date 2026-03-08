# memory-core

Standalone, reusable memory service for multi-app AI systems (PACER, mAItrix, and future apps).

## What it provides

1. Canonical memory schema across apps:
   - `tenantId`, `appId`, `actorId`, `threadId`
   - typed memories (`fact`, `preference`, `goal`, `project`, etc.)
2. Provider abstraction:
   - swap storage/retrieval backend without changing app code
3. Core operations:
   - ingest observations
   - search memory
   - build context blocks
   - actor profile summary
   - feedback loop for memory quality
4. HTTP API for cross-app use

## Current implementation

- Provider: in-memory reference provider (`src/providers/in-memory-provider.ts`)
- Retrieval: lexical overlap + recency + confidence/importance weighting
- Dedupe: actor/type/text exact dedupe at ingest
- Lifecycle: memory decay policy + compaction (`POST /v1/memory/compact`)

Use this as the baseline contract. Replace provider with:
1. Postgres + pgvector
2. Mem0 adapter
3. External vector providers

## Memory + embedding flow (small step-by-step)

1. App emits memory observations to `POST /v1/memory/ingest` after useful events.
2. `MemoryCoreService.ingest` normalizes text/metadata/confidence/importance/decay.
3. Provider dedupe checks for same actor + type + text and updates `lastSeenAt` if repeated.
4. Search/context calls (`/search`, `/context`) apply tenant/app/actor filters first.
5. Retrieval score combines:
   - lexical overlap (query vs memory text)
   - recency decay
   - confidence + importance
   - feedback boost/penalty
6. Context builder packs top memories into bounded `contextText` and includes actor profile summary.
7. App sends outcome feedback to `POST /v1/memory/feedback` (`selected`/`positive`/`negative`).
8. Periodic cleanup calls `POST /v1/memory/compact` to archive expired memories.

Embedding stage in this scaffold:
- The retrieval contract is already isolated in `MemoryProvider.search(...)`.
- To add real embeddings, implement a provider that:
  1. computes vectors on ingest,
  2. stores vectors with metadata,
  3. does ANN/hybrid search for `search(...)`.

## Run

From this folder:

```bash
npm install
npm run dev
```

Service starts on `http://0.0.0.0:7401` by default.

## Production-minded runtime config

Environment variables:
1. `PORT` (default `7401`)
2. `HOST` (default `0.0.0.0`)
3. `MEMORY_PROVIDER` (`in-memory` | `file`, default `in-memory`)
4. `MEMORY_FILE_PATH` (used when `MEMORY_PROVIDER=file`, default `./data/memory-core.json`)
5. `MEMORY_CORE_API_KEYS` (comma-separated API keys; if set, `/v1/*` requires auth)
6. `MEMORY_RATE_LIMIT_PER_MIN` (default `120`)

Health endpoints:
1. `GET /health` -> liveness
2. `GET /ready` -> readiness + provider status

## API

### Health
`GET /health`

### Ingest
`POST /v1/memory/ingest`

```json
{
  "observations": [
    {
      "tenantId": "camp",
      "appId": "pacer",
      "actorId": "user_123",
      "threadId": "session_abc",
      "memoryType": "preference",
      "text": "Prefers short outreach drafts with direct CTA",
      "source": { "sourceType": "agent_output", "sourceId": "run_1" },
      "metadata": { "agent": "marketing" },
      "confidence": 0.8,
      "importance": 0.7
    }
  ]
}
```

### Search
`POST /v1/memory/search`

```json
{
  "query": "outreach style preference",
  "filters": {
    "tenantId": "camp",
    "appId": "pacer",
    "actorId": "user_123",
    "memoryTypes": ["preference", "fact"]
  },
  "limit": 5
}
```

### Build context
`POST /v1/memory/context`

```json
{
  "query": "draft outreach to curator",
  "filters": {
    "tenantId": "camp",
    "appId": "pacer",
    "actorId": "user_123"
  },
  "budget": {
    "maxItems": 8,
    "maxChars": 3000
  }
}
```

### Profile
`GET /v1/memory/profile/:tenantId/:appId/:actorId`

### Feedback
`POST /v1/memory/feedback`

```json
{
  "memoryId": "mem_123",
  "signal": "positive"
}
```

### Compact expired memory
`POST /v1/memory/compact`

## SDK client for any agentic system

Use `MemoryCoreClient` from `src/client.ts`:

```ts
import { MemoryCoreClient } from "@maitrix/memory-core";

const memory = new MemoryCoreClient({
  baseUrl: "https://memory-core.internal",
  apiKey: process.env.MEMORY_CORE_API_KEY,
});

await memory.ingest({
  observations: [
    {
      tenantId: "camp",
      appId: "pacer",
      actorId: "wallet_1",
      memoryType: "preference",
      text: "Prefers concise answers",
      source: { sourceType: "assistant_reply" },
    },
  ],
});
```

## Integration pattern

### PACER
1. On task completion/workflow/release events, call `ingest`.
2. In `assembleContext`, call `context` endpoint and append returned `contextText`.
3. When memory-driven output is accepted/rejected, call `feedback`.

### mAItrix
1. Replace direct `UserMemoryService` writes with `ingest`.
2. Before building `AgentContext`, call `profile` or `context`.
3. Keep `LangChainMemoryService` for thread history, but use memory-core for cross-thread actor memory.
4. See `docs/MAITRIX_INTEGRATION_PLAN.md` for a concrete migration split.

## Next steps

1. Add `PgVectorProvider` implementation.
2. Add optional reranker stage.
3. Add memory decay/compaction jobs.
4. Add event ingestion queue for durability.
5. Add tracing dashboards and latency SLO alerts.

Production checklist and parity criteria are documented in:
- `docs/PRODUCTION_READINESS_PLAN.md`
