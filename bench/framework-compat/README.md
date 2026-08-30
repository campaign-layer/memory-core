# Agent framework compatibility and endurance campaign

This bench answers two different questions without conflating them:

1. Can an exact agent framework version discover and execute Memory Core's six
   stdio MCP tools against the shared authenticated service?
2. Does the service retain isolation and acknowledged data during a sustained,
   multi-principal Postgres run and bounded process/database failures?

It does not treat a config file, a CLI exit code, or an LLM's prose as proof of
compatibility.

## Evidence levels

| Level | Meaning | Minimum evidence |
| --- | --- | --- |
| L0 | Configuration/schema only | The host accepts a server definition. This is not a compatibility pass. |
| L1 | Real host discovery | The exact installed host launches the proxy and lists all six tools. |
| L2 | Deterministic real host execution | The host performs list, malformed-input rejection, remember, recall, context, feedback, supersede, forget, and cleanup without an LLM key. |
| L3 | Real model-driven execution | A named model selects and calls the required tools, with the tool trace and REST effect retained. This is probabilistic and reported separately. |

Every result is attached to the exact framework version. Never summarize a
partial matrix as universal compatibility.

## Covered deterministic hosts

The JavaScript lockfile pins and executes:

- Model Context Protocol TypeScript SDK 1.30.0
- LangChain MCP adapters 1.1.4
- LangGraph 1.4.13
- OpenAI Agents SDK 0.17.0 over its MCP client
- OpenAI Agents SDK 0.17.0 through Memory Core's native tool descriptors and
  the real `Runner` with a credential-free `ScriptedModel`

Separate Python environments are mandatory:

- AutoGen 0.7.5 with MCP 1.28.1
- CrewAI / CrewAI Tools 1.15.18 with MCP 1.28.1
- Hermes Agent 0.19.0 with its required MCP 1.26.0

CrewAI Tools 1.15.18 materializes omitted optional MCP arguments as JSON
`null`. Memory Core therefore treats `null` exactly like omission for the
optional `recall.types`, `forget.reason`, and `supersede.reason` fields. Empty
arrays, out-of-range values, and unknown enum values remain invalid.

Claude Code, Codex CLI, Hermes CLI, and OpenClaw are graded independently. A
Claude/Codex `mcp add` or `mcp list` is L0, not L1/L2. OpenClaw's
`mcp doctor --probe` and Hermes's `mcp test` can establish L1. L3 requires an
actual isolated agent turn and a captured tool trace. The REST port is not an
HTTP MCP endpoint; every stdio host launches `dist/integrations/mcp-server.js`
in remote mode.

## Production-shaped service under test

`compose.yml` creates a dedicated project, database network, client network,
Postgres volume, and loopback-only service port. It applies checksummed
migrations through the one-shot `npm run migrate` command, then starts the app
with:

- `MEMORY_ENV=production`
- `MEMORY_PROVIDER=postgres`
- an explicit Postgres URL
- exact principal credentials
- `MEMORY_PG_AUTO_MIGRATE=false`
- no external extractor/embedder

The application and database have CPU, memory, PID, and rotated-log bounds.
The campaign never runs `down -v`; failed state and the Postgres volume remain
available for forensics.

## Prepare a run

Use Node 24.15 or newer for the complete matrix because the pinned OpenClaw
host does not accept the bench host's system Node 18 or early Node 22 releases.
Run every command below from the repository root. Keep the Python environments
and CLI prefix outside the source tree so `git status` remains an independently
checkable source-provenance signal.

```bash
npm ci
npm run build

npm --prefix bench/framework-compat ci

python3.12 -m venv /opt/memory-core-framework-soak/venv-autogen
/opt/memory-core-framework-soak/venv-autogen/bin/pip install \
  -r bench/framework-compat/requirements-autogen.txt

python3.12 -m venv /opt/memory-core-framework-soak/venv-crewai
/opt/memory-core-framework-soak/venv-crewai/bin/pip install \
  -r bench/framework-compat/requirements-crewai.txt

python3.12 -m venv /opt/memory-core-framework-soak/venv-hermes
/opt/memory-core-framework-soak/venv-hermes/bin/pip install \
  -r bench/framework-compat/requirements-hermes.txt

npm install --prefix /opt/memory-core-framework-soak/cli \
  @anthropic-ai/claude-code@2.1.251 \
  @openai/codex@0.151.0 \
  openclaw@2026.7.1-2
```

Retain `npm ls --json` and `pip freeze` from all three environments with the
run. The probes also reject a host whose self-reported version differs from the
exact version expected by the generated configuration.

Generate a unique, permission-restricted run directory. The command refuses to
overwrite an existing `run.env`.

```bash
node bench/framework-compat/generate-config.mjs \
  --run-id 20260830T120000Z \
  --output /var/lib/memory-core-framework-soak/20260830T120000Z \
  --git-sha "$(git rev-parse HEAD)" \
  --source-state clean \
  --source-diff-sha256 none \
  --port 17401 \
  --duration-seconds 86400 \
  --fault-profile primary \
  --rps 2 \
  --concurrency 4 \
  --autogen-python /opt/memory-core-framework-soak/venv-autogen/bin/python \
  --crewai-python /opt/memory-core-framework-soak/venv-crewai/bin/python \
  --hermes-bin /opt/memory-core-framework-soak/venv-hermes/bin/hermes \
  --claude-bin /opt/memory-core-framework-soak/cli/node_modules/.bin/claude \
  --codex-bin /opt/memory-core-framework-soak/cli/node_modules/.bin/codex \
  --openclaw-bin /opt/memory-core-framework-soak/cli/node_modules/.bin/openclaw \
  --postgres-image pgvector/pgvector@sha256:REPLACE_WITH_INSPECTED_DIGEST
```

The generated `run.env` contains scoped credentials and must remain mode 0600.
Do not commit it, print it, attach it to reviews, or copy it into an artifact
bundle. `principals.sanitized.json` contains identities without keys.

Before a 24-hour run, generate a fresh 900-second `--fault-profile canary` on a
different run ID and port. It exercises the same four fault kinds at 60, 150,
300, and 450 seconds, but performs only the startup framework matrix so a
reprobe cannot delay the compressed fault schedule. Never reuse its database
volume or run directory for the primary campaign.

Start the production-shaped stack explicitly:

```bash
docker compose --env-file "$RUN_DIR/run.env" \
  -f bench/framework-compat/compose.yml build
docker compose --env-file "$RUN_DIR/run.env" \
  -f bench/framework-compat/compose.yml up -d
curl -fsS "http://127.0.0.1:17401/ready"
```

## Detached campaign

The controller runs deterministic framework probes at startup and, for the
primary profile, every five hours. It starts the mixed-principal HTTP soak,
samples Docker/Postgres resources,
and performs these isolated faults during a 24-hour run:

- 2h: graceful application restart
- 6h: application SIGKILL and restart
- 12h: graceful database restart
- 18h: database SIGKILL and crash recovery

It marks fault windows before acting, waits at most five minutes for readiness,
and requests an acknowledged-ID audit after recovery. The service and database
containers are dedicated to the Compose project; the campaign never changes
host networking, clock, memory pressure, or unrelated containers.

For an SSH-detached run, use systemd rather than `nohup` or tmux:

```bash
systemd-run \
  --unit=memory-core-framework-soak-20260830T120000Z \
  --description="Memory Core 24h framework compatibility soak" \
  --property=WorkingDirectory=/opt/memory-core-framework-soak/source \
  --property=EnvironmentFile=/var/lib/memory-core-framework-soak/20260830T120000Z/run.env \
  --property=Restart=no \
  --property=RuntimeMaxSec=26h \
  --property=MemoryMax=2G \
  --property=CPUQuota=100% \
  /opt/memory-core-framework-soak/node/bin/node \
  bench/framework-compat/campaign.mjs
```

`Restart=no` is deliberate. The campaign owns an exclusive start marker and an
in-memory fault schedule; it cannot safely resume after controller failure. A
restart would crash-loop or, worse, produce a partial run that resembles a
continuous one. Preserve the run directory and diagnose the failed campaign,
then generate a new run ID.

Inspect it without exposing the environment file:

```bash
systemctl status memory-core-framework-soak-20260830T120000Z
journalctl -u memory-core-framework-soak-20260830T120000Z -n 100 --no-pager
jq . "$RUN_DIR/heartbeat.json"
jq . "$RUN_DIR/summary.json"
jq . "$RUN_DIR/campaign-summary.json"
```

## Isolation and persistence oracle

The generated matrix contains two tenants, two spaces per tenant, two actors
per space, and a distinct least-privilege key for every framework app. The
preflight and periodic probes verify:

- actor memory crosses producer apps only for the same tenant/space/actor;
- foreign tenant, space, actor, and app impersonation is rejected;
- invalid keys return 401;
- an authorized-plus-forged batch writes nothing;
- exact foreign canaries never appear in search;
- every active acknowledged ID remains readable during normal operation and
  after planned recovery.

Any observed cross-principal canary or acknowledged-record loss is an immediate
hard stop. Disk below 10 GiB or 15%, readiness recovery beyond five minutes, or
a sustained unexpected error rate also stops load while preserving evidence.

## Artifacts and interpretation

Each run directory contains a sanitized manifest, locked versions, framework
probe transcripts, request/oracle/fault/resource NDJSON, heartbeats, latency
percentiles, final database counts, Compose image IDs, and service/database
logs. The live directory also contains credentials and must never be shared.
Create the fail-closed review bundle instead:

```bash
node bench/framework-compat/bundle-artifacts.mjs \
  --run-dir "$RUN_DIR" \
  --output "$RUN_DIR.review-bundle"
```

The exporter allowlists evidence, excludes `run.env`, `cli-state`, and
`framework-home`, then scans every copied file for all principal keys and the
Postgres credentials before publishing a checksum manifest. A failed scan
deletes no source evidence and produces no valid bundle.

Only a `primary` profile with at least 86,400 monotonic seconds and all four
scheduled faults can report `PASSED`. A green short run reports
`CANARY_PASSED`; a no-fault run reports `SMOKE_PASSED`. Neither is a production
qualification result.

The pass gates are zero isolation violations, zero acknowledged-write loss,
zero hard stops, successful L2 results for each framework claimed, and measured
recovery from every scheduled fault. Publish actual throughput, elapsed hours,
operation count, p50/p95/p99, resource behavior, and framework versions.

Even a green 24-hour run does not prove SOTA memory quality, atomic remote
supersede, exact-once concurrent ingest, multi-replica quotas/HA, backup/restore,
TLS/Internet hardening, or autonomous model tool-selection quality. Those are
separate release gates.
