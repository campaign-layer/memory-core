# Integration guide

Integrating memory-core from an application or agent framework.

For MCP clients, Anthropic/OpenAI tool use, the OpenAI Agents SDK, OpenClaw and Hermes, go
straight to [`src/integrations/README.md`](../src/integrations/README.md) — it covers the six
tools, both backends, and an explicit verified/not-verified list. This file covers the
HTTP/SDK path.

## Identity model

Five keys, resolved server-side wherever possible:

1. `tenantId` — organization boundary. **Required.**
2. `spaceId` — stable authorized sharing boundary inside the tenant. Optional for personal
   callers, where it defaults to `actorId`; a team must set the same explicit value in every
   participating agent.
3. `appId` — producer application and app-scope boundary. **Required.** It is provenance, not
   the general cross-agent read boundary.
4. `actorId` — user / wallet / agent identity. Required on ingest and strongly recommended on
   reads; actor-private records are invisible without it.
5. `threadId` — optional source conversation id. Use `accessThreadId` on reads to authorize
   thread-scoped records without filtering broader actor/workspace memories to that thread.

Visibility is explicit: `tenant` crosses spaces, `workspace` crosses actors and apps inside
one space, `app` stays with one producer app, `actor` follows one actor across apps, and
`thread` requires the same actor and current access thread. `tenantId` and `appId` remain
mandatory on every search and context call; providers throw rather than serve an unscoped
query.

Use `MEMORY_CORE_PRINCIPAL_API_KEYS` for agent credentials. Each grant binds an exact tenant,
effective space, producer app, and actor before any provider call; a caller cannot assert a
different actor with the same valid key. `MEMORY_CORE_TENANT_API_KEYS` is deliberately more
privileged: it is for tenant administrators or trusted identity-asserting gateways that may
act as any actor in that tenant. Reserve `MEMORY_CORE_API_KEYS` for global operators. In MCP
and tool-calling paths, identity comes from trusted server configuration, never model input.
A principal-bound HTTP caller can select a thread only within its bound actor.

## Minimal loop

1. **Before the model call** — `POST /v1/memory/context`, splice `contextText` into the
   system/developer prompt.
2. **After the turn** — extract memory candidates yourself, then `POST /v1/memory/ingest`.
   By default memory-core does **not** extract: it accepts already-formed statements, and
   sending raw conversation turns stores raw turns. An opt-in LLM extractor
   (`MEMORY_EXTRACTOR=llm`) exists but is off by default and has no measured quality number,
   so treat app-side extraction as the supported path.
3. **On accept/reject** — `POST /v1/memory/feedback` with the memory id and
   `selected` | `positive` | `negative`.
4. **On a schedule** — `POST /v1/memory/compact` to archive decay-expired records.

Watch for on step 1: the complete emitted block obeys `maxChars`, but the budget is counted in
**characters, not model tokens**. Query-relevant memories receive budget priority; selection
still has no measured diversity policy, and the profile block scans up to 1,000 visible
records on every call. Each emitted line carries its memory id, scope, tenant, space, app,
actor, event time, and source type, and selected text is not silently shortened;
treat the block as stored evidence at the same or lower authority as the current user message,
not as a system instruction. Keep `maxItems` modest.

## Required fields, in practice

The validation that bites most often (`src/http.ts`):

```json
{
  "observations": [{
    "tenantId": "acme",
    "appId": "support-bot",
    "actorId": "user_42",
    "memoryType": "preference",
    "text": "Prefers Postgres over MySQL",
    "source": { "sourceType": "chat" }
  }]
}
```

- `source` is **required**, with a non-empty `sourceType`.
- `text` must be **≥ 4 characters**; it is whitespace-collapsed and truncated to 1000.
- `memoryType` is one of `fact`, `preference`, `goal`, `project`, `episode`, `tool_outcome`,
  `instruction`, `profile`, `pattern`, `summary`.
- Optional: `spaceId`, `threadId`, `scope`, `summary`, `metadata`, `confidence`, `importance`,
  `decayPolicy`, `observedAt`.
- Search/context `filters` require `tenantId` **and** `appId`. Set an explicit `spaceId` for
  a shared team space; personal integrations can rely on the `actorId` default.
- HTTP feedback requires `tenantId`, `appId`, and `actorId`; pass `spaceId` plus
  `accessThreadId` when applicable.

## From TypeScript

> **memory-core is not published to npm.** `package.json` is `private: true` and declares no
> `exports` map, so a bare-specifier import does not resolve for a consumer. Today the working
> options are a relative import from a vendored checkout (`./memory-core/src/index.js`), a git
> dependency, or — the recommended path — talking to a running service over HTTP with
> `MemoryCoreClient`. The examples below use the package specifier for readability; substitute
> your own path.

```typescript
import { MemoryCoreClient } from "memory-core";

const memory = new MemoryCoreClient({
  baseUrl: process.env.MEMORY_CORE_URL!,
  apiKey: process.env.MEMORY_CORE_API_KEY,   // sent as x-api-key
});

const context = await memory.buildContext({
  query: userMessage,
  filters: { tenantId: "acme", appId: "support-bot", actorId },
  budget: { maxItems: 8, maxChars: 1500 },
});

const answer = await model.generate({
  system: `${basePrompt}\n\n<memory>\n${context.contextText}\n</memory>`,
  messages,
});

await memory.ingest({
  observations: extractMemories(answer).map((text) => ({
    tenantId: "acme", appId: "support-bot", actorId,
    memoryType: "fact",
    text,
    source: { sourceType: "assistant_turn" },
  })),
});
```

To skip HTTP entirely, construct the service in-process:

```typescript
import { MemoryCoreService, InMemoryProvider } from "memory-core";

const service = new MemoryCoreService(new InMemoryProvider());
```

## Framework mapping

| Framework | Approach |
|---|---|
| Claude Code, Claude Desktop, any MCP host | The MCP server, embedded or remote. See [`src/integrations/README.md`](../src/integrations/README.md). |
| Anthropic / OpenAI tool use | `toAnthropicTools()` / `toOpenAITools()` + `dispatch()`, or the `runAnthropicTurn` / `runOpenAITurn` helpers. |
| OpenAI Agents SDK | `toOpenAIAgentsTools(ctx)`. Field names are from vendor docs and unverified here. |
| OpenClaw | MCP is the recommended path. Config key is **`mcp.servers`**, not `mcpServers`, and OpenClaw ships its own bundled plugin also named `memory-core` — register under a distinct id to avoid the collision. |
| Hermes Agent | MCP via `~/.hermes/config.yaml` (`mcp_servers`, snake_case), or the Python plugin in `src/integrations/adapters/hermes-plugin/`. |
| LangChain / LangGraph | Call memory-core in graph nodes, pre- and post-model. `langchain` is not a dependency; `toOpenAITools()` + `dispatch()` covers a `StructuredTool` wrapper in a few lines. |
| Custom orchestrators | `MemoryCoreClient`, or `createMemoryToolkit(ctx)` for a runtime-agnostic tool list. |

## Splitting responsibilities

A split that has held up in practice:

1. Keep the verbatim thread transcript in the app. memory-core is not a transcript store.
2. Move cross-thread actor and profile memory into memory-core.
3. Keep domain-specific extraction in the app — the built-in extractor is off by default and
   unmeasured.
4. Let memory-core own retrieval, lifecycle and the context block.

## Before you rely on retrieval quality

Read [`BENCHMARKS.md`](./BENCHMARKS.md). Four findings change integration decisions:

- **Revised facts are not handled.** Duplicate detection is exact-text equality, so
  "moved to Berlin" is stored next to "lives in Lisbon" and both stay retrievable. If your
  domain has updatable facts, call the `supersede` MCP tool explicitly, or set the old record's
  status yourself through the provider — there is no HTTP route for it yet.
- **Set `MEMORY_EMBEDDER` if recall matters.** BM25-only retrieval gates on term overlap, so a
  query that shares no words with the memory returns nothing. `MEMORY_EMBEDDER=local` runs
  offline after a one-time ~35 MB download and moved R@5 from 62.5% to 83.0% on the synthetic
  corpus, at roughly 58x the search latency.
- **`enhanced` and `dual-layer` are deprecated.** Use the default `in-memory`, `file` for
  single-node persistence, or `postgres` for anything durable.
- **The score is not a confidence signal.** Relevance is max-normalized, so the top hit always
  scores near 1.0 however weak the match. Do not threshold on it to decide whether the memory
  is relevant; measured false-positive rates on unanswerable queries are 50–67%.
