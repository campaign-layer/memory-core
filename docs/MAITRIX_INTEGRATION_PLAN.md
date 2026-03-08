# mAItrix Integration Plan for `memory-core`

This plan maps existing mAItrix memory logic to the standalone `memory-core` service so both `matrix` and `maitrix` backends can share one memory contract.

## Current state in mAItrix

1. Thread/session memory:
   - `LangChainMemoryService` stores short-term conversation history.
2. Actor/profile memory:
   - `UserMemoryService` stores cross-thread user facts/preferences/goals.
3. Runtime flow:
   - AI service loads actor memory before response generation.
   - AI service extracts and upserts memories after model output.

## Target split

1. Keep local thread history in app (`LangChainMemoryService` equivalent).
2. Move cross-thread memory to `memory-core`:
   - ingest (`/v1/memory/ingest`)
   - retrieval/context (`/v1/memory/context`)
   - profile (`/v1/memory/profile/:tenantId/:appId/:actorId`)
   - feedback (`/v1/memory/feedback`)
3. Keep domain logic in app, memory lifecycle in `memory-core`.

## Request mapping

1. Before LLM call:
   - call `/v1/memory/context` with `{ tenantId, appId, actorId, query }`
   - append `contextText` to system context.
2. After response:
   - extract candidate memories (fact/preference/goal/project/outcome).
   - call `/v1/memory/ingest` with `sourceType=assistant_reply`.
3. After user accepts/rejects output:
   - call `/v1/memory/feedback` with `positive` or `negative`.
4. Daily/weekly maintenance:
   - call `/v1/memory/compact` to archive expired memories.

## Multi-app identifiers

Use this key model consistently:
1. `tenantId`: company/network (`camp`)
2. `appId`: app identity (`pacer`, `maitrix`, `matrix`)
3. `actorId`: wallet/user id
4. `threadId`: optional chat/session id

This keeps one shared memory service while preserving strict app/user isolation.
