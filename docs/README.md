# memory-core Docs

Short, current docs for how memory-core works and what is needed for production.

## Read This First

1. [WORKING_OVERVIEW.md](./WORKING_OVERVIEW.md) - request flow, memory flow, context flow
2. [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) - how to plug into any agent framework/app
3. [PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md) - current state vs production requirements
4. [BENCHMARKS.md](./BENCHMARKS.md) - benchmark method and latest local results

## System in one line

`memory-core` is an HTTP memory service with pluggable providers (`in-memory`, `file`, `mem0`) and a stable API for ingest, retrieval, context building, feedback, and compaction.

