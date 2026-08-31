# memory-core integrations

Drop-in memory for agents. Six tools, one zod source of truth (`tools.ts`), and adapters
generated from it — Anthropic, OpenAI-compatible, MCP, OpenClaw, Hermes, or your own loop.

The exact-version support matrix and L0–L3 definitions are maintained in
[`docs/INTEGRATION_GUIDE.md`](../../docs/INTEGRATION_GUIDE.md#verified-framework-matrix).
Support levels are intentionally route-specific: a generic MCP lifecycle pass does not turn
Claude Code or Codex configuration acceptance into an autonomous-agent pass.

## The tool surface

| Tool | What it does | Why an agent needs it |
| --- | --- | --- |
| `remember` | Store one durable fact (`text`, `type`, `importance`, `scope`) | Nothing persists unless something writes it |
| `recall` | Ranked search with ids, scores, and match reasons | The alternative is guessing or asking the user to repeat themselves |
| `build_context` | One character-budgeted block, profile + relevant memories | The high-value call: splice straight into a system prompt |
| `forget` | Mark a memory wrong; stops being recalled | Without a correction path, bad memories are permanent |
| `supersede` | Replace an outdated memory in one step, keeping its type/scope | "Moved to Lisbon" is a change, not an error |
| `feedback` | `used` / `useful` / `not_useful` on a recalled id | Ranking improves instead of drifting |

Only `text`/`query`/`memoryId` are required; everything else defaults. **Tenant, space, app,
actor, and thread access are never model-supplied** — they come from server config, so a model
cannot choose a broader sharing boundary. A missing required identity throws rather than
defaulting.

## 1. MCP client (Claude, Codex, and any MCP host)

Two modes. **Embedded** owns its own provider; **remote** proxies a running memory-core
service. Both are verified working.

Embedded, persisting to a file:

```json
{
  "mcpServers": {
    "memory-core": {
      "command": "node",
      "args": ["/absolute/path/to/memory-core/dist/integrations/mcp-server.js"],
      "env": {
        "MEMORY_TENANT_ID": "acme",
        "MEMORY_SPACE_ID": "madhav-personal",
        "MEMORY_APP_ID": "claude-code",
        "MEMORY_ACTOR_ID": "madhav",
        "MEMORY_PROVIDER": "file",
        "MEMORY_FILE_PATH": "/Users/madhav/.memory-core/store.json"
      }
    }
  }
}
```

Remote, against a shared service:

```json
{
  "mcpServers": {
    "memory-core": {
      "command": "node",
      "args": ["/absolute/path/to/memory-core/dist/integrations/mcp-server.js"],
      "env": {
        "MEMORY_CORE_URL": "https://memory.internal.acme.dev",
        "MEMORY_CORE_API_KEY": "sk-mc-...",
        "MEMORY_TENANT_ID": "acme",
        "MEMORY_SPACE_ID": "madhav-personal",
        "MEMORY_APP_ID": "claude-code",
        "MEMORY_ACTOR_ID": "madhav"
      }
    }
  }
}
```

Claude Code: `~/.claude.json` (or `.mcp.json` in the project). Claude Desktop:
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.

Codex uses the same stdio server; the REST service itself is not an HTTP MCP endpoint:

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
codex mcp list
```

Build first with `npm run build`. See the complete shared local setup, including distinct
principal grants for Claude, Codex, and Hermes, in
[`docs/INTEGRATION_GUIDE.md`](../../docs/INTEGRATION_GUIDE.md#connect-local-agents-to-the-shared-service).

### Environment

| Var | Required | Notes |
| --- | --- | --- |
| `MEMORY_TENANT_ID` / `MEMORY_APP_ID` / `MEMORY_ACTOR_ID` | yes | Server exits 1 with a usage message if any is missing |
| `MEMORY_SPACE_ID` | no | Stable personal/team sharing boundary. Defaults to actor id; use the same explicit value in every agent that should share workspace memory |
| `MEMORY_THREAD_ID` | no | Scopes `thread`-scoped writes and tags the source session |
| `MEMORY_CORE_URL` | no | Set it and the server runs in remote mode |
| `MEMORY_CORE_API_KEY` | no | Sent as `x-api-key` |
| `MEMORY_CORE_MODE` | no | Force `embedded` or `remote` |
| `MEMORY_PROVIDER` | no | `in-memory` \| `file` \| `enhanced` \| `dual-layer`. Defaults to `file` — `in-memory` loses everything on restart |
| `MEMORY_FILE_PATH` | no | Defaults to `./data/memory-core.json` |
| `MEMORY_SOURCE_TYPE` | no | Recorded on every write. Defaults to `mcp` |

The server logs only to stderr (stdout is the JSON-RPC channel) and shuts down cleanly on
SIGINT, SIGTERM, or stdin close.

### Cross-agent sharing

Give Codex, Hermes, OpenClaw, and any other producer the same `MEMORY_TENANT_ID` and
`MEMORY_SPACE_ID`, but keep distinct `MEMORY_APP_ID` values for provenance. Scope still
controls visibility inside the space: `actor` follows one actor across apps, `workspace`
crosses actors and apps, `app` stays with one producer, and `thread` requires the same actor
and current thread. Omitting `MEMORY_SPACE_ID` creates a privacy-preserving personal space
named after `MEMORY_ACTOR_ID`.

### Verify it yourself

```bash
npx tsx src/integrations/verify-mcp.ts
# add remote-mode coverage against a running service:
VERIFY_REMOTE_URL=http://127.0.0.1:7401 VERIFY_REMOTE_API_KEY=... npx tsx src/integrations/verify-mcp.ts
```

The remote verifier uses `tenant=acme`, `space=user_42`, `app=remote-harness`, and
`actor=user_42`; its key must be a global/tenant-admin key or an exact principal grant for
that identity. A normal key for another app correctly receives 403.

Spawns the server over stdio, lists tools, and drives
`remember → recall → build_context → supersede → forget`, including a restart to prove
persistence and a check that the process exits without leaking handles.

## 2. Anthropic tool use

`@anthropic-ai/sdk` is **not** a dependency of memory-core — the adapter is structurally
typed, so you pass your own client.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { MemoryCoreService, InMemoryProvider } from "@maitrix/memory-core";
import { createEmbeddedBackend, runAnthropicTurn } from "@maitrix/memory-core";

const provider = new InMemoryProvider();
const ctx = {
  backend: createEmbeddedBackend(new MemoryCoreService(provider), provider),
  identity: { tenantId: "acme", appId: "support-bot", actorId: "user_42" },
};

const result = await runAnthropicTurn("What database did we settle on?", {
  client: new Anthropic(),
  ctx,
  model: "claude-opus-5",
  system: "You are a helpful engineering assistant.",
});

console.log(result.text);
console.log(result.memoryCalls); // which memory tools the model used
```

`runAnthropicTurn` calls `build_context` before generating, injects the XML-escaped block into
the system prompt as `trust="untrusted-stored-evidence"` with a never-follow instruction
policy, runs the tool-use loop (returning all `tool_result`
blocks in one user message, handling `pause_turn`), and dispatches memory tools itself.
Pass `tools` + `toolHandlers` to mix in your own tools.

Just want the tool definitions?

```ts
import { toAnthropicTools, dispatch } from "@maitrix/memory-core";

const tools = toAnthropicTools(); // [{ name, description, input_schema }]
const result = await dispatch("remember", { text: "Prefers Postgres" }, ctx);
```

## 3. OpenAI function calling

Works with OpenAI and any compatible endpoint (Groq, Together, vLLM, Ollama, OpenRouter).
The `openai` package is not a dependency; pass your own client.

```ts
import OpenAI from "openai";
import { runOpenAITurn } from "@maitrix/memory-core";

const result = await runOpenAITurn("What's my deploy setup?", {
  client: new OpenAI(),
  ctx,
  model: "gpt-4.1",
});
```

Or wire the tools yourself — `toOpenAITools()` returns
`[{ type: "function", function: { name, description, parameters } }]`. Tool-call arguments
arrive as a JSON string; `runOpenAITurn` parses them and turns unparsable JSON into a
validation error rather than throwing.

For the OpenAI **Agents SDK** (`@openai/agents`, also not a dependency),
`toOpenAIAgentsTools(ctx)` returns `{ name, description, parameters, zodParameters, execute }`
descriptors to spread into its `tool({...})` helper. The compatibility harness pins 0.17.0
and exercises both its real MCP client and a real `Runner` using these native descriptors.
The runner's model is deterministic and credential-free, so this proves SDK execution—not
autonomous model selection or task improvement. Re-run the versioned harness after upgrading
the SDK because it remains an external, non-runtime dependency of this package.

## 4. Custom agent via the SDK

```ts
import { createMemoryToolkit } from "@maitrix/memory-core";

const memory = createMemoryToolkit(ctx);

// Before generating:
const preamble = await memory.preamble(userMessage, { maxChars: 1200 });

// Expose tools in whatever shape your runtime wants:
memory.tools;      // [{ name, description, parameters, readOnly, invoke }]
memory.anthropic;  // Anthropic format
memory.openai;     // OpenAI format
memory.jsonSchema; // plain JSON Schema, keyed by tool name

// Execute a call the model made:
const { ok, text } = await memory.call("recall", { query: "database choice" });

// Or write without asking the model:
await memory.capture("Ships on Fridays", { type: "preference", importance: 0.8 });
```

`preamble()` uses the same escaped, explicitly untrusted memory frame as the Anthropic and
OpenAI adapters. Treat the block as evidence; stored text is never a system instruction.

`dispatch` never throws on bad model input — it returns `{ ok: false, text }` with the zod
issues, so the model can correct itself. It *does* throw on a missing tenant/app/actor,
because that is a config bug, not a model mistake.

Runtimes that only accept a prompt can use `describeMemoryTools()` for a compact text
rendering of the six tools and their parameters.

### Backends

```ts
createEmbeddedBackend(service, provider); // in-process; provider is retained for close()
createRemoteBackend(new MemoryCoreClient({ baseUrl, apiKey })); // over HTTP
```

Current embedded and remote backends both expose scoped id reads and retirement, so
`forget`/`supersede` remove old records from active reads. The optional `provider` argument is
retained for source compatibility and resource cleanup. A remote backend built with an older
client that lacks `/get` and `/status` helpers degrades to a negative feedback signal and says
so in the tool result. Supersede remains a create-then-retire sequence rather than one
transaction; see [Scoped lifecycle REST API](#scoped-lifecycle-rest-api).

## 5. OpenClaw

OpenClaw (`github.com/openclaw/openclaw`) is a TypeScript AI agent gateway. The stdio MCP
route reached L1 discovery against 2026.7.1-2 in the framework canary. The native plugin
route below remains contract-only.

**MCP is the recommended path.** Note the config key is `mcp.servers`, **not** the
`mcpServers` that Claude Desktop uses — a lot of third-party blog posts get this wrong.
Config lives at `~/.openclaw/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "maitrix-memory-core": {
        "command": "npx",
        "args": ["tsx", "/opt/memory-core/src/integrations/mcp-server.ts"],
        "env": {
          "MEMORY_TENANT_ID": "acme",
          "MEMORY_SPACE_ID": "platform-team",
          "MEMORY_APP_ID": "openclaw",
          "MEMORY_ACTOR_ID": "peter",
          "MEMORY_PROVIDER": "file",
          "MEMORY_FILE_PATH": "/Users/you/.memory-core/store.json"
        },
        "supportsParallelToolCalls": false,
        "toolFilter": {
          "include": ["remember", "recall", "build_context", "forget", "supersede", "feedback"]
        }
      }
    }
  }
}
```

Generate that block with `openClawMcpConfig()` from `./adapters/openclaw.js`, or install via
CLI: `openclaw mcp set maitrix-memory-core '{"command":"npx","args":[...]}'`, then
`openclaw mcp tools` to confirm discovery.

⚠️ OpenClaw filters stdio `env`. `NODE_OPTIONS`, `PYTHONSTARTUP`, `LD_*`, `DYLD_*`, and
`BASH_FUNC_*` are dropped; credential-shaped names (`*_API_KEY`, `GITHUB_TOKEN`, …) pass
through. `MEMORY_CORE_API_KEY` matches the allowlist, but **we have not confirmed that
arbitrary vars like `MEMORY_TENANT_ID` survive the filter.** If the server exits 1 with
"Missing required env", that is the cause — check `openclaw mcp doctor` and fall back to
passing identity through `args`-adjacent config or a wrapper script.

**Tool-plugin path.** `memoryCoreOpenClawTools(ctx)` in `./adapters/openclaw.ts` returns
descriptors for OpenClaw's `tool(...)` factory, and `openClawPluginManifest()` emits the
`openclaw.plugin.json` fragment:

```ts
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { memoryCoreOpenClawTools } from "@maitrix/memory-core";

export default defineToolPlugin({
  id: "maitrix-memory-core",
  name: "Maitrix Memory Core",
  description: "Durable cross-session memory.",
  tools: (tool) => memoryCoreOpenClawTools(ctx).map((spec) => tool(spec)),
});
```

Not verified: `openclaw` and `typebox` are not dependencies here, so these shapes are
compile-checked against nothing. OpenClaw's docs build `parameters` with typebox
`Type.Object(...)`, whose runtime value is a plain JSON Schema object — so passing our JSON
Schema directly is *expected* to work, but confirm with `openclaw plugins validate`.

⚠️ **Name collision.** OpenClaw ships its own bundled plugin called `memory-core`. Use a
distinct id — the helpers default to `maitrix-memory-core`.

**Not implemented: OpenClaw's native memory slot.** `api.registerMemoryCapability()` is an
*exclusive* slot (one memory plugin at a time, selected via `plugins.slots.memory`), and the
`MemoryCapability` interface is not published in OpenClaw's prose docs — it lives in
`src/plugins/types.ts`. Read that type before implementing; we deliberately did not guess it.
That path would also let memory-core supply `registerMemoryPromptSupplement` and
`registerEmbeddingProvider`, making it the agent's memory backend rather than six tools.

## 6. Hermes

Two unrelated things are called Hermes. Both are real:

- **Hermes Agent** (`github.com/NousResearch/hermes-agent`) — a Python 3.11–3.13 agent with
  MCP support and a plugin system. **This is the integration target.**
- **Nous Hermes models** (Hermes 2/3/4, OpenHermes) — model *weights* with a `<tool_call>`
  prompt convention. No plugin surface: use `toOpenAITools()` with whatever host serves them,
  or the MCP server if the host speaks MCP.

**MCP path.** `~/.hermes/config.yaml`, key `mcp_servers` (snake_case, unlike OpenClaw):

```yaml
mcp_servers:
  memory_core:
    command: node
    args: [/opt/memory-core/dist/integrations/mcp-server.js]
    env:
      MEMORY_TENANT_ID: acme
      MEMORY_SPACE_ID: platform-team
      MEMORY_APP_ID: hermes
      MEMORY_ACTOR_ID: peter
      MEMORY_CORE_URL: http://127.0.0.1:7401
      MEMORY_CORE_API_KEY: sk-mc-abc123
    supports_parallel_tool_calls: false
    tools:
      include: [remember, recall, build_context, forget, supersede, feedback]
      prompts: false
      resources: false
```

Generate it with `hermesMcpConfigYaml()` from `./adapters/hermes.js`. Hermes namespaces MCP
tools as `mcp_<server>_<tool>`, so the model sees `mcp_memory_core_recall`. Reload without a
restart via `/reload-mcp`. The real Hermes 0.19.0 host reached L1 connection and six-tool
discovery in the framework canary; deterministic lifecycle execution through Hermes itself
and model-driven use remain untested.

**Native Python plugin.** `./adapters/hermes-plugin/` is a Hermes tool plugin that talks to
a memory-core service over HTTP using only the Python standard library:

```bash
cp -r src/integrations/adapters/hermes-plugin ~/.hermes/plugins/memory-core
export MEMORY_CORE_URL=http://127.0.0.1:7401 MEMORY_CORE_API_KEY=sk-mc-...
export MEMORY_TENANT_ID=acme MEMORY_SPACE_ID=platform-team
export MEMORY_APP_ID=hermes MEMORY_ACTOR_ID=peter
hermes plugins enable memory-core
```

`schemas.json` is **generated** from `tools.ts` — regenerate after any schema change:

```bash
npx tsx src/integrations/generate-schemas.ts
```

CI regenerates and diffs this artifact. The Python boundary also enforces the generated
type/scope enums, numeric and string bounds, and explicit space/thread requirements before
making an HTTP request.

Handlers honour Hermes' documented contract: `(args: dict, **kwargs) -> str`, always a JSON
string, never raise. All six were exercised against a live memory-core service; error paths
(missing config, unreachable service, bad signal) were checked too. They have **not** been
run inside a live Hermes install — the plugin loader itself is unverified here.

**Not implemented: Hermes' `MemoryProvider` ABC** (`agent/memory_provider.py`), the deeper
"be the memory backend" integration. It is well documented — `is_available()`,
`initialize(session_id, **kwargs)`, `get_tool_schemas()`, `handle_tool_call()`,
`get_config_schema()`, `save_config()`, plus optional `system_prompt_block()`, `prefetch()`,
`sync_turn()` (must be non-blocking), `on_session_end()`, `on_pre_compress()`. It is
mutually exclusive with any other external memory provider, so it is a product decision
rather than an additive adapter. Storage paths must use the `hermes_home` kwarg, never a
hardcoded `~/.hermes`.

## LangChain

The framework harness pins `@langchain/mcp-adapters` 1.1.4 and LangGraph 1.4.13 in its own
lockfile. Both reached L2 by discovering and executing the complete lifecycle against the
remote service. They remain bench-only dependencies; the production package does not force
LangChain into an application that does not use it.

## Verified vs not

**Verified by running it:**

- MCP server starts, advertises 6 tools, and answers `tools/call` over stdio in **both**
  embedded and remote mode
- `remember → recall → build_context → feedback → supersede → forget` end to end
- Memories survive a server restart (file provider)
- Server process exits cleanly when the client disconnects
- Bad input is rejected before reaching a handler (MCP SDK validation, then zod)
- Remote mode against a live memory-core HTTP service with `x-api-key` auth enforced
- LangChain MCP adapters 1.1.4, LangGraph 1.4.13, OpenAI Agents 0.17.0 (MCP and native
  descriptors/real runner), AutoGen 0.7.5 and CrewAI 1.15.18 at L2 in the exact-version
  framework canary
- Hermes Agent 0.19.0 and OpenClaw 2026.7.1-2 at L1 host connection/tool discovery
- Claude Code 2.1.251 and Codex CLI 0.151.0 at L0 isolated configuration acceptance/readback
- The Hermes Python handlers against a live memory-core service, happy path and error paths
- `node:test` coverage over schemas, dispatch, identity pinning, and the
  Anthropic/OpenAI/generic exports
- Python contract tests for Hermes identity pinning, enum validation, and shared-scope guards

**Not verified — shapes from vendor docs, no local install to compile against:**

- OpenClaw `defineToolPlugin` / `tool(...)` field names, and whether plain JSON Schema is
  accepted where the docs show typebox
- Whether OpenClaw's stdio env filter passes `MEMORY_*` vars through
- The Hermes plugin loading inside a real Hermes install
- Anthropic and OpenAI adapters are structurally typed against their SDKs; the wire shapes
  follow current docs but no live API call was made

**Not verified as an outcome:** no host has a retained L3 autonomous model-selection trace or
a paired memory-on/off task-success result. See
[`docs/AGENT_EVALUATION.md`](../../docs/AGENT_EVALUATION.md).

**Deliberately not built:** OpenClaw `MemoryCapability` (interface unpublished) and Hermes
`MemoryProvider` (documented, but an exclusive slot and a product decision).

## Scoped lifecycle REST API

Remote MCP and Hermes use scoped id reads and retirement, so `forget` and `supersede` have
the same active-set semantics as embedded mode:

```
POST /v1/memory/get     { memoryId, tenantId, spaceId?, appId, actorId, accessThreadId? }
POST /v1/memory/status  { memoryId, status: "superseded" | "archived", metadata?, ...identity }
```

Both return a neutral null/`updated:false` for missing or unauthorized ids. Status mutation
is provider-level and atomic; the public endpoint deliberately cannot restore an inactive
record to `active`. Supersede is still a two-request create-then-retire sequence, so a rare
concurrent change is reported as a partial operation that requires reconciliation.
