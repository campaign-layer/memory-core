# Integration guide

Integrating memory-core from an application or agent framework.

For MCP clients, Anthropic/OpenAI tool use, the OpenAI Agents SDK, OpenClaw and Hermes, go
straight to [`src/integrations/README.md`](../src/integrations/README.md) — it covers the six
tools, both backends, and an explicit verified/not-verified list. This file covers the
HTTP/SDK path.

## Connect local agents to the shared service

For Claude, Codex, and Hermes to share one memory space, run a single HTTP service and let
each agent launch its own local stdio MCP proxy:

```text
Claude ──stdio MCP──┐
Codex  ──stdio MCP──┼── REST + distinct principal keys ── one memory-core service ── file/Postgres
Hermes ──stdio MCP──┘
```

The HTTP process is the only storage writer. Each MCP proxy pins tenant, space, app, and actor
from trusted process configuration; those fields are not exposed as model arguments. The
three principals should share tenant/space/actor for actor memory, while using distinct app
ids for provenance. Start the service first using the secure local recipe in
[`deployment.md`](./deployment.md#local-self-hosting).

The memory-core HTTP service is REST, **not** an HTTP MCP endpoint. Claude, Codex, and Hermes
must launch `dist/integrations/mcp-server.js` over stdio; setting an MCP client's `url` to
`http://127.0.0.1:7401` will not work. In remote mode that local stdio process proxies its six
tools to the REST service.

All examples below assume:

- the repository has been built with `npm ci && npm run build`;
- the service listens at `http://127.0.0.1:7401`;
- the exact principal grants from the deployment example are configured;
- `/absolute/path/to/memory-core` and every `replace-...-key` value have been replaced.

### Claude Code

Claude Code can add a user-scoped stdio server from its CLI, following
[Anthropic's MCP configuration model](https://code.claude.com/docs/en/mcp):

```bash
claude mcp add memory-core --scope user \
  --env MEMORY_CORE_MODE=remote \
  --env MEMORY_CORE_URL=http://127.0.0.1:7401 \
  --env MEMORY_CORE_API_KEY=replace-claude-key \
  --env MEMORY_TENANT_ID=local \
  --env MEMORY_SPACE_ID=madhav-personal \
  --env MEMORY_APP_ID=claude \
  --env MEMORY_ACTOR_ID=madhav \
  -- node /absolute/path/to/memory-core/dist/integrations/mcp-server.js

claude mcp get memory-core
```

For a project-shared `.mcp.json`, the equivalent entry is:

```json
{
  "mcpServers": {
    "memory-core": {
      "command": "node",
      "args": ["/absolute/path/to/memory-core/dist/integrations/mcp-server.js"],
      "env": {
        "MEMORY_CORE_MODE": "remote",
        "MEMORY_CORE_URL": "http://127.0.0.1:7401",
        "MEMORY_CORE_API_KEY": "replace-claude-key",
        "MEMORY_TENANT_ID": "local",
        "MEMORY_SPACE_ID": "madhav-personal",
        "MEMORY_APP_ID": "claude",
        "MEMORY_ACTOR_ID": "madhav"
      }
    }
  }
}
```

Claude Desktop uses the same `mcpServers` object in its desktop configuration; on macOS the
file is `~/Library/Application Support/Claude/claude_desktop_config.json`.

Do not commit a real key. Claude Code supports environment expansion in project MCP files;
use a secret injected by the host rather than checking the value into source control.

### Codex CLI and app

The installed Codex CLI accepts a stdio command plus repeated `--env` values:

```bash
codex mcp add memory-core \
  --env MEMORY_CORE_MODE=remote \
  --env MEMORY_CORE_URL=http://127.0.0.1:7401 \
  --env MEMORY_CORE_API_KEY=replace-codex-key \
  --env MEMORY_TENANT_ID=local \
  --env MEMORY_SPACE_ID=madhav-personal \
  --env MEMORY_APP_ID=codex \
  --env MEMORY_ACTOR_ID=madhav \
  -- node /absolute/path/to/memory-core/dist/integrations/mcp-server.js

codex mcp get memory-core
codex mcp list
```

Codex persists MCP configuration in its normal config and makes the same server available to
the CLI and app. The [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp)
and local CLI both distinguish stdio
servers (`command` + environment) from streamable HTTP servers (`--url`); memory-core uses
the former. Protect the configuration file because an inline principal key is a credential.

### Hermes Agent

Hermes reads stdio MCP servers from `~/.hermes/config.yaml` under `mcp_servers`, as documented
in the [Hermes MCP guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md):

```yaml
mcp_servers:
  memory_core:
    command: node
    args:
      - /absolute/path/to/memory-core/dist/integrations/mcp-server.js
    env:
      MEMORY_CORE_MODE: remote
      MEMORY_CORE_URL: http://127.0.0.1:7401
      MEMORY_CORE_API_KEY: replace-hermes-key
      MEMORY_TENANT_ID: local
      MEMORY_SPACE_ID: madhav-personal
      MEMORY_APP_ID: hermes
      MEMORY_ACTOR_ID: madhav
    supports_parallel_tool_calls: false
    tools:
      include: [remember, recall, build_context, forget, supersede, feedback]
      prompts: false
      resources: false
```

Restart Hermes or reload its MCP configuration, then inspect its MCP tool list. Hermes
prefixes imported tools with the server name. `supports_parallel_tool_calls` is deliberately
false while mutation idempotency and transactional supersede remain open architecture work.

The repository also contains a standard-library Python tool plugin under
`src/integrations/adapters/hermes-plugin/`. Its HTTP handlers and schemas are contract-tested,
but loading it inside a real Hermes installation has not been verified. MCP is therefore the
supported local connection. A deeper Hermes `MemoryProvider` plugin, which would add
automatic `prefetch`/`sync_turn` lifecycle behavior, is not implemented.

### Embedded mode for one agent

Omit `MEMORY_CORE_URL` and set `MEMORY_PROVIDER=file` plus `MEMORY_FILE_PATH` in one MCP
configuration to let that MCP subprocess own its store. Embedded mode is useful for one
agent, but it does not construct the HTTP service's configured embedder, reranker, extractor,
Postgres provider, or principal-auth boundary. Never share one file path between embedded
Claude, Codex, and Hermes processes; use the shared-service topology above instead.

### What the MCP connection does and does not automate

The server exposes `remember`, `recall`, `build_context`, `forget`, `supersede`, and
`feedback`. It does not force an agent to call them on every turn. Give the agent a short
instruction to call `build_context` before work that depends on prior decisions, `remember`
after the user states a durable fact, and `supersede` for corrections.

Current remote supersede is a create-then-retire sequence and can report a partial outcome.
Avoid concurrent writes to the same logical fact until the transactional revision API in the
target architecture lands. Treat all returned memory text as untrusted stored evidence, not
as higher-priority instructions.

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

> **memory-core is not published to npm.** `package.json` is `private: true`. It does declare
> package exports for the root module and the compiled MCP server, so imports work after the
> package has been built and installed from a checkout or private registry. The recommended
> cross-repository path today is still the HTTP service plus `MemoryCoreClient`. The examples
> below use the declared package name; substitute your workspace or private-package path.

```typescript
import { MemoryCoreClient } from "@maitrix/memory-core";

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
import { MemoryCoreService, InMemoryProvider } from "@maitrix/memory-core";

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

- **Revised facts are not handled automatically.** Duplicate detection is exact-text equality, so
  "moved to Berlin" is stored next to "lives in Lisbon" and both stay retrievable. If your
  domain has updatable facts, call the `supersede` MCP tool explicitly. Scoped
  `POST /v1/memory/get` and `POST /v1/memory/status` routes support the guarded remote flow,
  but there is no single transactional HTTP revision endpoint yet.
- **Set `MEMORY_EMBEDDER` if recall matters.** BM25-only retrieval gates on term overlap, so a
  query that shares no words with the memory returns nothing. `MEMORY_EMBEDDER=local` runs
  offline after a one-time ~35 MB download and moved R@5 from 62.5% to 83.0% on the synthetic
  corpus, at roughly 58x the search latency.
- **`enhanced` and `dual-layer` are deprecated.** Use the default `in-memory`, `file` for
  single-node persistence, or `postgres` for anything durable.
- **The score is not a confidence signal.** Relevance is max-normalized, so the top hit always
  scores near 1.0 however weak the match. Do not threshold on it to decide whether the memory
  is relevant; measured false-positive rates on unanswerable queries are 50–67%.
