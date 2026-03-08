# memory-core Production Readiness + Parity Plan

This file defines what "production-grade" means for `memory-core` and what is still required to reach Mem0/Supermemory-class quality.

## Baseline now (implemented)

1. Standalone HTTP service (`/health`, `/ready`, `/v1/memory/*`).
2. API-key protection for `/v1/*` when `MEMORY_CORE_API_KEYS` is configured.
3. Per-identity rate limiting (`MEMORY_RATE_LIMIT_PER_MIN`).
4. Provider abstraction with pluggable backends (`in-memory`, `file`).
5. Memory lifecycle controls (decay + compaction).
6. Typed SDK client for external agent systems (`MemoryCoreClient`).
7. Basic automated tests for ingest/dedupe/context/compaction/persistence.

## Required for production approval

1. Durable multi-writer store:
   - `PgVectorProvider` (Postgres + pgvector) or equivalent.
2. Horizontal scale safety:
   - distributed rate limiter, shared queue, idempotency keys.
3. Security:
   - per-tenant auth scopes, audit logging, secret rotation.
4. Reliability:
   - retry queue, dead-letter handling, backpressure controls.
5. Observability:
   - request metrics, retrieval quality metrics, tracing, alerting.
6. Release quality gates:
   - integration tests + load tests + regression eval suite.

## Parity targets vs Mem0/Supermemory

To claim "on par", implement and measure all of the below:
1. Hybrid retrieval:
   - vector + keyword + metadata filters + recency/feedback weighting.
2. Reranking:
   - model-based reranker on top-k candidates.
3. Memory graph/entity linking:
   - relationship edges across actor/entity/tool/outcome.
4. Memory quality loop:
   - acceptance/usage-driven promotion and demotion.
5. Eval benchmark:
   - objective recall@k, nDCG@k, latency p95, cost/query.

## Suggested SLOs

1. Search latency p95 <= 120 ms for top-20 retrieval.
2. Context build latency p95 <= 180 ms.
3. Availability >= 99.9%.
4. Recall@10 >= 0.80 on your internal benchmark set.
