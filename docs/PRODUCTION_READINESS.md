# Production Readiness

Current status and what is still needed for production-grade deployment.

## What is already in place

1. Standalone HTTP service with readiness/liveness checks
2. Input validation for all memory endpoints
3. API key auth option (`MEMORY_CORE_API_KEYS`)
4. In-process rate limiting (`MEMORY_RATE_LIMIT_PER_MIN`)
5. Provider abstraction (`in-memory`, `file`, `mem0`)
6. Memory lifecycle controls (decay + compact)
7. SDK client (`MemoryCoreClient`)
8. Unit tests for core service behavior

## Gaps to close before production

1. Durable distributed store by default:
   - add `PgVectorProvider` (Postgres + pgvector) with proper indexes
2. Horizontal scaling safety:
   - distributed rate limiter
   - idempotency keys for ingest
   - queue/retry for async ingest path
3. Security hardening:
   - scoped auth per tenant/app
   - audit logs for memory read/write operations
   - secret rotation and policy enforcement
4. Reliability:
   - dead-letter queue for failed ingest/update operations
   - backpressure controls and circuit breakers
5. Observability:
   - metrics (latency, error rate, recall proxy)
   - tracing across app -> memory-core -> provider
   - SLO dashboards + alerts
6. Evaluation:
   - retrieval quality benchmark (`Recall@k`, `nDCG@k`, latency p95, cost/query)

## Practical parity target vs Mem0/Supermemory-class systems

1. Hybrid retrieval (vector + lexical + metadata filters)
2. Optional reranker on top-k candidates
3. Strong eval harness tied to release gates
4. Multi-tenant isolation and operational maturity (security + observability)

