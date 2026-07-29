# Integration guide

Integrating memory-core from an application or agent framework.

For MCP clients, Anthropic/OpenAI tool use, the OpenAI Agents SDK, OpenClaw and Hermes, go
straight to [`src/integrations/README.md`](../src/integrations/README.md) — it covers the six
tools, both backends, and an explicit verified/not-verified list. This file covers the
HTTP/SDK path.

## Identity model

Four keys, resolved server-side wherever possible:

1. `tenantId` — org / network boundary. **Required.**
2. `appId` — application boundary. **Required.**
3. `actorId` — user / wallet / agent identity. Required on ingest; optional as a search filter,
   but omitting it widens the search to the whole app.
4. `threadId` — optional conversation / session id.

`tenantId` and `appId` are mandatory on every search and context call; providers throw rather
than serve an unscoped query. Note that API keys are **not** scoped to a tenant — a valid key
reaches every tenant, so isolation protects against accidents, not a hostile caller.

In the MCP and tool-calling paths, identity comes from server config and is never
model-supplied, so a model cannot write into the wrong tenant.

## Minimal loop

1. **Before the model call** — `POST /v1/memory/context`, splice `contextText` into the
   system/developer prompt.
2. **After the turn** — extract memory candidates yourself, then `POST /v1/memory/ingest`.
   memory-core does **not** extract: it accepts already-formed statements. Sending raw
   conversation turns stores raw turns.
3. **On accept/reject** — `POST /v1/memory/feedback` with the memory id and
   `selected` | `positive` | `negative`.
4. **On a schedule** — `POST /v1/memory/compact` to archive decay-expired records.

Watch for on step 1: the budget is counted in **characters, not tokens** (roughly 4x off, and
model-dependent), selection is greedy with no diversity, and the profile block is built from a
full unbounded actor scan on every call. Keep `maxItems` modest.

## Required fields, in practice

The validation that bites most often (`src/http.ts`):

```json
{
  "observations": [{
    "tenantId": "camp",
    "appId": "pacer",
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
- Optional: `threadId`, `scope`, `summary`, `metadata`, `confidence`, `importance`,
  `decayPolicy`, `observedAt`.
- Search/context `filters` require `tenantId` **and** `appId`.

## From TypeScript

```typescript
import { MemoryCoreClient } from "@maitrix/memory-core";

const memory = new MemoryCoreClient({
  baseUrl: process.env.MEMORY_CORE_URL!,
  apiKey: process.env.MEMORY_CORE_API_KEY,   // sent as x-api-key
});

const context = await memory.buildContext({
  query: userMessage,
  filters: { tenantId: "camp", appId: "pacer", actorId },
  budget: { maxItems: 8, maxChars: 1500 },
});

const answer = await model.generate({
  system: `${basePrompt}\n\n<memory>\n${context.contextText}\n</memory>`,
  messages,
});

await memory.ingest({
  observations: extractMemories(answer).map((text) => ({
    tenantId: "camp", appId: "pacer", actorId,
    memoryType: "fact",
    text,
    source: { sourceType: "assistant_turn" },
  })),
});
```

To skip HTTP entirely, construct the service in-process:

```typescript
import { MemoryCoreService, InMemoryProvider } from "@maitrix/memory-core";

const service = new MemoryCoreService(new InMemoryProvider());
```

## Framework mapping

| Framework | Approach |
|---|---|
| Claude Code, Claude Desktop, any MCP host | The MCP server, embedded or remote. See [`src/integrations/README.md`](../src/integrations/README.md). |
| Anthropic / OpenAI tool use | `toAnthropicTools()` / `toOpenAITools()` + `dispatch()`, or the `runAnthropicTurn` / `runOpenAITurn` helpers. |
| OpenAI Agents SDK | `toOpenAIAgentsTools(ctx)`. Field names are from vendor docs and unverified here. |
| OpenClaw | MCP is the recommended path. Config key is **`mcp.servers`**, not `mcpServers`, and OpenClaw ships its own bundled plugin also named `memory-core` — register as `maitrix-memory-core` to avoid the collision. |
| Hermes Agent | MCP via `~/.hermes/config.yaml` (`mcp_servers`, snake_case), or the Python plugin in `src/integrations/adapters/hermes-plugin/`. |
| LangChain / LangGraph | Call memory-core in graph nodes, pre- and post-model. `langchain` is not a dependency; `toOpenAITools()` + `dispatch()` covers a `StructuredTool` wrapper in a few lines. |
| Custom orchestrators | `MemoryCoreClient`, or `createMemoryToolkit(ctx)` for a runtime-agnostic tool list. |

## Splitting responsibilities

A split that has held up in practice:

1. Keep the verbatim thread transcript in the app. memory-core is not a transcript store.
2. Move cross-thread actor and profile memory into memory-core.
3. Keep domain-specific extraction in the app — memory-core has no extractor.
4. Let memory-core own retrieval, lifecycle and the context block.

## Before you rely on retrieval quality

Read [`BENCHMARKS.md`](./BENCHMARKS.md). Two findings change integration decisions:

- **Revised facts are not handled.** Duplicate detection is exact-text equality, so
  "moved to Berlin" is stored next to "lives in Lisbon" and both stay retrievable. If your
  domain has updatable facts, call the `supersede` MCP tool explicitly, or set the old record's
  status yourself through the provider — there is no HTTP route for it yet.
- **The `enhanced` provider is the worst-measured option** despite its name. Use the default
  `in-memory`, `file` for single-node persistence, or `postgres` for anything durable.
