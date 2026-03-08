# Integration Guide

Use this pattern for PACER, mAItrix, matrix, or any agent framework.

## Identity model

1. `tenantId` - org/network boundary (example: `camp`)
2. `appId` - application boundary (example: `pacer`, `maitrix`, `matrix`)
3. `actorId` - user/wallet/agent identity
4. `threadId` - optional conversation/session id

## Minimal integration loop

1. Before LLM call:
   - call `POST /v1/memory/context`
   - append `contextText` to system/developer prompt
2. After assistant/tool output:
   - extract memory candidates
   - call `POST /v1/memory/ingest`
3. After user acceptance/rejection:
   - call `POST /v1/memory/feedback`
4. On schedule (daily/weekly):
   - call `POST /v1/memory/compact`

## Framework mapping

1. LangChain/LangGraph:
   - run memory-core calls in graph nodes (pre-LLM and post-LLM)
2. AutoGen/CrewAI/OpenAI Agents SDK:
   - use memory-core as external memory service over HTTP
3. Custom orchestrators:
   - use `MemoryCoreClient` from `src/client.ts`

## Example integration split (mAItrix-style)

1. Keep thread transcript memory local in app.
2. Move cross-thread actor/profile memory to memory-core.
3. Keep domain extraction logic in app; keep lifecycle/retrieval in memory-core.

