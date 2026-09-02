# Codex run summary

## 2026-08-28 — cross-agent isolation and production hardening

### Scope

Audit the current memory architecture, establish a 2026 research-informed direction, make a
first production-hardening pass, exercise the agent integrations and local benchmarks, and
use local Kimi as an independent architecture/plan/code reviewer. The working tree was already
dirty at `0211baf`; this entry describes the resulting slice and does not attribute every
pre-existing edit to this run.

### Changes

- Added a stable `spaceId` sharing boundary, separate from producer `appId`, with one central
  tenant/space/app/actor/thread visibility policy used by every provider.
- Closed opaque-ID authorization gaps in get, feedback, forget, and supersede flows. A caller
  can no longer mutate another actor's private memory merely by guessing its ID.
- Propagated spaces through REST, SDK types, MCP, Hermes, and OpenClaw. Remote supersede now
  performs a scoped authorization preflight before writing a replacement.
- Hardened the HTTP boundary: pre-hashed credentials, auth-before-rate-limit ordering,
  bounded limiter state, explicit proxy-hop trust, safe request IDs, baseline security/cache
  headers, correct JSON-parser errors, generic internal failures, and query-free access logs.
- Added tenant-bound credentials. `MEMORY_CORE_TENANT_API_KEYS` maps a credential to one or
  more tenants, every route checks the requested tenant before provider access, mixed-tenant
  ingest is rejected before its first write, and store-wide compaction requires an explicit
  global operator key. Startup rejects a credential configured as both tenant and global.
- Added a privacy-preserving `space_id` migration. Legacy rows enter the owning actor's
  personal space; operators must explicitly remap records that should remain shared.
- Updated architecture and integration documentation, including a research-informed path
  toward evidence/inference separation, temporal and scene consolidation, asynchronous
  maintenance, experience learning, and implicit-persona evaluation.
- Changed the default container dependency stages to omit the optional local-ONNX stack.
  `MEMORY_CORE_INCLUDE_LOCAL_ONNX=true` is now an explicit build opt-in pending a clean audit.
- Fixed `buildContext` so its character limit bounds the complete emitted prompt, including
  profile, headers, and separators. Relevant evidence is budgeted before profile background,
  and only complete summarized profile entries are emitted.
- Made context evidence traceable: every emitted record carries a stable memory id, event
  time, and source type; structured response entries expose full provenance, and profile
  background no longer duplicates query-selected records.
- Added `bench/context.ts`, a deterministic agent-facing regression harness over the existing
  synthetic corpus. It separates evidence inclusion from ordering, including gold-at-one,
  MRR, stale-over-current, hard-negative-over-gold, abstention leakage, duplicate selection,
  exact-budget, utilization, and latency metrics. The LoCoMo fixture now includes the new
  space boundary.
- Added provider-level atomic, scope-checked retirement plus `/v1/memory/get` and
  `/v1/memory/status`. Current remote MCP and Hermes can now read an id safely and truly
  archive/supersede it instead of merely applying a ranking penalty; older servers retain an
  explicit downrank-only compatibility path.
- Wired the existing reranker seam into `MemoryCoreService.search`. `MEMORY_RERANKER=voyage`
  now cross-encodes a bounded broad-recall set, exposes the cross-encoder score, applies a
  configurable score gate, and fails open to the exact original provider query after a
  five-second/no-retry attempt. A 60-second cooldown prevents repeated outage latency.
- Refreshed the lockfile and raised the declared runtime floor to Node 20. The default
  production dependency set now audits clean; four high-severity advisories remain isolated
  to the explicit local-ONNX image option.

### How it works now

An app is provenance; a space is the durable sharing boundary. Personal calls default the
space to `actorId`. Within a space, tenant scope is broadest, workspace scope is shared,
app scope is limited to one producer, actor scope follows one actor across producers, and
thread scope requires the current actor and access thread. The same policy applies to search,
context construction, direct-ID reads, feedback, deletion, and supersession in in-memory,
file, enhanced, dual-layer, and Postgres providers.

The REST boundary normalizes missing personal spaces before invoking the service. Tenant
credentials authorize only their configured tenant set; global operator credentials can
cross tenants and compact the store. Authenticated requests are limited by a digest of the
valid key; anonymous requests use the direct or explicitly trusted proxy address. Health and
readiness remain available to orchestrators.

The default Docker image supports lexical retrieval and hosted Voyage/OpenAI embedders. Local
ONNX remains available only through an explicit opt-in build and is not release-ready while
its native dependency tree has unresolved advisories.

Provider-native ranking remains the default. When Voyage reranking is selected, the service
recalls 50–100 candidates, reranks stored memory text, filters by the final cross-encoder
score, and fails open during hosted-service degradation. Reranker quality is not claimed
until a credentialed benchmark is recorded.

### Files touched

- Access model and providers: `src/access.ts`, `src/types.ts`, `src/provider.ts`,
  `src/providers/*`, `migrations/001_init.sql`
- Service and HTTP edge: `src/service.ts`, `src/http.ts`, `src/config.ts`, `src/client.ts`,
  `src/index.ts`, `src/retrieval/rerank.ts`
- Agent integrations: `src/integrations/*`, including generated Hermes schemas
- Tests: service, integration isolation/tooling, hybrid search, and Postgres provider suites
- Benchmarks: `bench/context.ts`, `bench/README.md`, `bench/types.ts`, and
  `bench/locomo/run_retrieval.ts`
- Operations and documentation: `Dockerfile`, `package.json`, `package-lock.json`,
  `README.md`, `CONTRIBUTING.md`, and `docs/*`

### Validation

- Node 20 full local suite: 153 tests, 152 passed, 1 opt-in ONNX test skipped, 0 failed.
- Postgres suite: 24 tests, 20 passed, 4 pgvector-dependent tests skipped, 0 failed.
- `npm run build`, `npm run typecheck`, and `git diff --check` passed on the final checkpoint.
- MCP verifier passed end to end in embedded and authenticated tenant-scoped remote modes,
  including remember, recall, feedback, forget, supersede, authorization, and graceful
  shutdown. Negative probes confirmed a valid Acme key receives 403 for Globex search and
  store-wide compaction.
- Small stable BM25 bench passed: R@1 40.9%, R@5 62.5%, R@10 89.8%, MRR 0.615,
  nDCG 0.648. These are internal regression metrics, not claims of parity with public SOTA.
- The new context regression (small seed 1337, fixed 2026-08-28 anchor, 8 items/3,000 chars)
  retained 76.92% of labeled evidence with 72.73% all-gold contexts, 47.73% gold-at-one,
  0.5992 MRR, and zero budget violations. Stale evidence outranked the current fact in 37.5%
  of update contexts, hard negatives outranked gold in 36.36% of applicable contexts, and
  every abstention context leaked evidence. Near-duplicate pairs were only 0.22%. These are
  repository-authored regression signals, not public benchmark or SOTA scores.
- The credentialed context runner fails loudly when Voyage is requested without
  `VOYAGE_API_KEY`; no reranker quality result was silently replaced with baseline output.
- Python Hermes adapter compiled successfully.
- The prior container build reached TypeScript compilation and layer export, but local Docker
  Desktop/Colima storage failed with containerd metadata I/O errors. The final image has not
  received a trustworthy runtime smoke test on this machine.
- `npm audit --omit=dev --omit=optional` reports 0 vulnerabilities for the default runtime.
  The opt-in local-ONNX dependency set reports 4 high-severity advisories with no currently
  available fix, under `@huggingface/transformers`, `onnxruntime-node`/`adm-zip`, and `sharp`.

### Risks and follow-ups

- **Not production-ready yet.** Per-process rate limiting, no durable security audit trail,
  limited metrics/tracing, no backup/restore drill, serial/non-transactional batch ingest,
  and no multi-replica soak remain release blockers.
- Hosted reranking is implemented but unmeasured here because no Voyage credential is
  available. `/ready` does not expose reranker cooldown/degradation, and its score threshold
  still needs calibration on a development split. Concurrent first failures are not
  coalesced.
- Explicit retirement is atomic within a provider call, but remote supersede remains a
  create-then-retire sequence across two requests. A failure between them can leave both
  records active; a transactional revision API/outbox remains necessary.
- pgvector is absent locally, so vector-index migration and retrieval tests need a clean bench
  database. The Postgres lexical path is covered.
- `buildContext` still uses character rather than tokenizer budgeting and a capped but broad
  profile scan. Its full-output bound and evidence provenance are tested; temporal
  consolidation, evidence-linked answers, experience extraction, and calibrated forgetting
  remain implementation work. Measured duplicate selection is currently negligible, so MMR
  is below stale-evidence and abstention precision in priority.
- Public evaluation must expand to LongMemEval-V2, PersonaMem-v2, and task/outcome metrics;
  the current small bench is only a regression check.
- The repository does not identify which configured SSH hosts are the bench boxes. Remote
  rollout must wait for an explicit host mapping and deployment authority.
- Kimi review is **not complete**. Architecture and code prompts were tried against
  `kimi-code/k3`, `kimi-code/k3-256k`, `kimi-code/kimi-for-coding`, and
  `kimi-code/kimi-for-coding-highspeed`. `kimi doctor` and OAuth/provider discovery are
  healthy, but every actual managed-provider request returned HTTP 500; the latest default
  `k3` attempt ran for roughly 160 seconds without review output before failing. There are no
  Kimi findings or sign-off to report. It remains a standing adversarial release gate.

## 2026-08-29 — principal-bound access, retrieval hardening, and Opus audit

### Scope

Continue the prior hardening pass through a production-oriented code, integration, migration,
benchmark, and container checkpoint. Claude Opus 5 was used as an independent read-only
architecture and adversarial reviewer over sealed source snapshots. This remains a release
candidate, not a production or SOTA certification: held-out memory quality, backup/restore,
multi-replica load, distributed quota, and durable audit evidence are still external gates.

### Changes

- Replaced tenant-only normal-agent credentials with principal grants bound to the exact
  tenant/effective-space/app/actor coordinate. Tenant-admin keys remain an explicit trusted
  identity-assertor class; operator keys remain global. Every REST route authorizes before
  provider access, and startup rejects credentials reused across privilege classes.
- Centralized visibility, owner immutability, dedupe coordinates, and personal-space
  resolution. UUID record ids and JSON-encoded compound keys remove delimiter-collision
  ambiguity. All five providers apply actor/thread/workspace visibility on search, list,
  direct-id reads, feedback, and retirement.
- Preserved source scope and thread on dual-layer events and insights, removed all projections
  when their evidence is retired or expires, rechecks visibility on cache hits, and
  invalidates derived caches after extraction/consolidation. Regression tests cover hostile
  identifier delimiters and thread-derived-memory isolation.
- Made Postgres migrations ordered, checksummed, and advisory-lock serialized. Migration 002
  adds privacy-preserving spaces without mutating 001. Request paths no longer run schema
  DDL; readiness rejects the legacy pre-space schema. Vector reads select only the current
  embedding model, while hosted embedding failure degrades to lexical search with counters
  and cooldown. Feedback cannot refresh an already expired row.
- Made auto-migration an explicit pre-listen production boot phase. A fresh Postgres database
  is migrated before it can enter the readiness loop; migration or cleanup failure exits
  non-zero. The checksum ledger verifies SHA-256 for applied sources, deliberately upgrades
  legacy null checksums, and provisions a dimension only when its table is genuinely absent.
- Wired service-level hosted reranking to a bounded 50–100 candidate recall. Provider errors
  are not attributed to the reranker, a reranker failure reuses the already-fetched ranking
  without a second provider call, provider and cross-encoder thresholds are separate, and
  counters make benchmark fallback observable and fatal when reranking was requested.
- Reworked context construction around complete evidence, relevant-first ordering, exact
  whole-block character bounds, stable ids, source/owner/space/scope/time provenance, and a
  correct emitted-record count. Ungrounded extractor fallbacks stay stored but are withheld
  from model prompts.
- Framed stored memory as escaped, explicitly untrusted evidence in Anthropic, OpenAI, and
  generic prompt adapters. Recall emits complete JSON-quoted text rather than a silent
  180-character truncation. Hermes validates generated enums and all tool bounds locally;
  Python contract tests cover identity pinning, shared-scope requirements, and replacement of
  server-derived memory types/scopes without widening model-supplied allowlists.
- Fixed SDK URL construction for reverse-proxy base paths and hostile path/query characters.
  MCP releases backend resources on close. HTTP input amplification, error detail/status
  confusion, auth/rate-limit ordering, request-id reflection, and sensitive query logging are
  bounded or genericized.
- Made the optional local ONNX stack an explicit image opt-in. CI covers Node 20 and 22,
  unit/build/bench typechecks, deterministic fixture regeneration, context regression,
  Postgres+pgvector, generated Hermes schema drift, Python contracts, and an ONNX-free
  production container booted against pgvector. HTTP shutdown and provider close are bounded.
- Kept extraction windows inside one visibility scope, rejected malformed GET type filters
  rather than silently widening them, exempted orchestrator probes from admission-control
  state, and removed provider/model/version/detail leakage from public readiness responses.
  The bounded pre-auth limiter evicts the oldest window instead of globally rejecting new
  identities at capacity.
- Turned benchmark warnings into CI failures when a non-control ranker is at/below random and
  regenerate both small and large fixtures. MCP shutdown now bounds server/provider close and
  exits non-zero on failure; the documented MCP package subpath has an explicit export.
- Restricted package artifacts to runtime output, generated declarations, migrations, README,
  and license; compiled tests/tools, local Claude settings, review evidence, source, and
  benchmark corpora are no longer packable. The exported TypeScript declaration paths now
  exist and the MCP package subpath resolves from the built package.

### Claude Opus review

- The initial sealed architecture and adversarial reviews both returned `BLOCK`. Their raw
  JSON, source manifest, prompt/model/session metadata, and hashes are preserved under
  `docs/reviews/claude-opus-2026-08-29/initial/`.
- No P0/P1 issue remained in the first post-fix checkpoint. Opus identified three P2 release
  blockers: delimiter-ambiguous dual-layer cache keys, widened scope on derived insights, and
  Postgres feedback reviving inactivity-expired rows. All three are fixed with regression
  tests in the current tree.
- The frozen final security lane returned `ADVISORY` with no blockers. Its release/operations
  lane returned `BLOCK` on two issues: fresh auto-migrating Postgres could remain permanently
  unready, and the claimed migration checksums were not implemented. Both are fixed in the
  current tree, alongside all of that pass's P3 findings.
- A second sealed, focused Opus 5 delta review returned `ADVISORY`, explicitly marked both
  release blockers fixed, and found no P0/P1/P2 blocker. Prompt, immutable source manifest,
  model/session/cost metadata, and receipts are preserved under
  `docs/reviews/claude-opus-2026-08-29/`. The command transport truncated the completed delta
  payload before it was written; replay was unavailable because the run disabled session
  persistence, and a capture retry hit Claude's session cap. The receipt discloses that raw
  evidence limitation rather than reconstructing missing bytes.

### Validation at this checkpoint

- Node 20 and Node 22 each report 171 tests: 170 passed, the opt-in ONNX semantic test skipped,
  and zero failed. TypeScript typecheck, bench typecheck, build, schema regeneration, and four
  Python Hermes contract tests pass.
- Postgres: 31 outcomes, 24 passed locally, seven pgvector-only cases skipped, zero failed.
  The pgvector service in CI is the release check for the skipped vector/model/DDL paths.
- MCP embedded end to end passes remember, complete recall, context, feedback, restart
  persistence, supersede, forget, and resource-releasing shutdown.
- The enforceable internal retrieval gate passes: in-memory R@1 40.9%, R@10 89.8%, MRR
  0.615, nDCG@10 0.648 versus analytic-random R@10 1.9%. Context evidence recall is 0.7692,
  gold-at-one 0.4773, MRR 0.5992, with no character-budget violation. Stale-over-current is
  0.375 and abstention leakage remains 1.0. These are stable repository-authored regression
  signals only, not public benchmark or SOTA scores.
- Small and large generated fixtures are byte-stable, `git diff --check` passes, migration
  001 is unchanged, and the default production dependency graph previously audited at zero
  vulnerabilities when dev and optional ONNX dependencies are omitted.

### Remaining release gates

- Pass GitHub CI on the pushed branch, especially the clean pgvector and container jobs that
  cannot be reproduced on this machine's unavailable Docker daemon.
- Exercise backup and restore, migration timing on representative data, concurrent replicas,
  rolling deploy and failure recovery on an identified bench environment.
- Add a durable read/write/retirement audit sink and shared fleet quota enforcement.
- Add a transactional revision endpoint; remote supersede is intentionally reported as a
  guarded two-request operation that can return a partial outcome.
- Calibrate hosted embedding/reranking on a held-out development split, then evaluate a
  non-repository-authored LongMemEval/LoCoMo-style end-to-end context workload. The current
  stale-over-current and abstention leakage numbers explicitly block production-quality and
  SOTA claims.
- Audit or replace the optional ONNX dependency chain before enabling it in a release image.

## Run: 2026-08-29 16:24 (IST)

### Scope

Turn the verified security, atomicity, provenance, temporal-quality, profile, migration, and
operations gaps into one production architecture proposal; document a safe local shared
service; and provide accurate Claude, Codex, and Hermes connection paths. The pass also fixes
the executable quickstart and adds the existing MCP lifecycle verifier to CI.

### Changes

- Added a complete prioritized gap register and a proposed relational architecture built on
  immutable evidence, append-only versions, one transactional current head, persisted
  idempotency, bounded/rebuildable relations, explicit answerable/abstain/conflict decisions,
  and deterministic structured profiles.
- Defined the target fail-closed startup and SDK transport contracts, atomic batch/revision
  APIs, extraction quarantine boundary, expand/backfill/cutover migration, release tests,
  quantitative quality gates, and deliberately deferred feature set.
- Added a secure local self-hosting topology: one loopback HTTP service is the sole file
  writer, while Claude, Codex, and Hermes use distinct principal credentials and local stdio
  MCP proxies to share one tenant/space/actor.
- Added built-JavaScript connection commands for Claude Code, Codex CLI/app, and Hermes, plus
  embedded-mode limitations and an explicit warning that the REST port is not an HTTP MCP
  endpoint.
- Corrected stale package imports and lifecycle claims. Root package imports now match the
  actual export map; current remote `/get` and `/status` behavior is documented; embedded MCP
  no longer inherits service embedder/reranker/extractor/Postgres claims.
- Fixed `examples/quickstart.mjs` for the minimal readiness response, complete feedback
  identity, operator-only compaction, and current Node/runtime guidance.
- Added `npm run verify:mcp` to the Node 22 CI lane.

### How It Works Now

1. Build the checkout and run one memory-core HTTP process on `127.0.0.1` with file or
   Postgres persistence and one exact principal grant per agent app.
2. Claude, Codex, and Hermes each launch the compiled MCP server over stdio in remote mode.
   The proxy pins identity from its environment and calls the shared REST service with its
   own key.
3. Same tenant/space/actor plus different app ids shares actor-scoped memories while retaining
   producer provenance; app and thread scopes remain narrower.
4. The architecture document describes the proposed V2 mutation/truth model. That model is
   not implemented by this documentation pass; current remote supersede remains non-atomic.

### Files Touched

- `.github/workflows/ci.yml` — gate the embedded MCP lifecycle and restart verifier.
- `README.md` — loopback quickstart, local self-host links, and correct embedded/remote claims.
- `docs/ARCHITECTURE.md` — verified gap register and proposed production V2 architecture.
- `docs/INTEGRATION_GUIDE.md` — local Claude, Codex, and Hermes connection walkthrough.
- `docs/deployment.md` — safe local topology, identity grants, storage and security limits.
- `docs/README.md` — updated documentation map.
- `src/integrations/README.md` — built stdio commands, Codex setup, correct imports/lifecycle.
- `examples/quickstart.mjs` — executable readiness/auth/feedback/compaction walkthrough.
- `docs/CODEX_RUN_SUMMARY.md` — this handoff entry.

### Validation

- Node 20 TypeScript typecheck and build passed.
- Node 20 unit/integration suite: 171 outcomes, 170 passed, one opt-in ONNX test skipped, zero
  failed.
- MCP end to end passed all six tools, file restart persistence, supersede, forget, and clean
  shutdown; the compiled MCP entry point starts with the documented identity variables.
- Updated HTTP quickstart passed end to end against a short-lived loopback service and the
  service shut down cleanly.
- Hermes Python contract tests passed 4/4; `node --check examples/quickstart.mjs` and
  `git diff --check` passed.
- Codex stdio syntax was checked against the installed Codex CLI and official OpenAI MCP
  documentation. Claude and Hermes shapes were checked against their official documentation.
- GitHub CI run `33248998776` passed every job: Node 20/22, the new MCP lifecycle gate,
  benchmark/context determinism, Postgres + pgvector, Hermes schemas/contracts, and the
  production container readiness smoke.

### Risks / Follow-ups

- A new local Kimi collaboration was attempted with the full gap list, but `kimi-code/k3`
  returned HTTP 403 for its five-hour usage quota before any dialogue. No Kimi architecture
  agreement or sign-off is claimed. The previous partial Kimi findings were independently
  reproduced; this ADR remains ready for a verbatim Kimi challenge after quota reset.
- The target evidence/version/current-head model is a proposal, not shipped behavior. The P1
  insecure default listener/SDK redirect findings and P2 ingestion/extraction/revision gaps
  remain open in code.
- Generic MCP protocol behavior is locally verified, but this pass did not run a real Claude,
  Codex, or Hermes host through the full shared-service scenario.
- Representative migration/load, multi-replica chaos, backup/restore, distributed quota,
  audit export, and held-out abstention/temporal targets remain release gates.

## Run: 2026-08-30 00:09 (IST)

### Scope

Implement the smallest safe P0-A prerequisite for the proposed V2 ledger, challenge the
architecture with local Kimi, keep the local Claude/Codex/Hermes self-hosting path accurate,
run the full local validation matrix, and prepare the branch for GitHub and Codex Cloud.

### Changes

- Changed the configured server default from all interfaces to `127.0.0.1`. An
  unauthenticated non-loopback listener now fails closed unless the explicit development-only
  override is enabled. `MEMORY_ENV=production` rejects that override and requires credentials,
  Postgres, an explicit database URL, and application auto-migration disabled.
- Hardened `MemoryCoreClient`: absolute URL validation, no URL credentials/query/fragment,
  HTTPS outside literal loopback, redirects rejected, a 10-second whole-response deadline,
  deterministic deadline errors, and a 1 MiB default response limit.
- Hardened hosted embedder/reranker/extractor transport: redirects rejected; fetch, body read,
  retry sleeps, and all attempts share one deadline; response bodies are bounded; server
  `Retry-After` is clamped. Timeout-induced transport errors normalize to the declared
  deadline error.
- Kept failed extraction and successful no-accepted-facts windows as operator-searchable raw
  evidence, labelled them separately as `fallback` and `no_facts`, and excluded both from
  prompt assembly by default. The deprecated enhanced-provider prompt path enforces the same
  quarantine.
- Updated deployment, working-overview, and root documentation for safe local hosting,
  Docker/Kubernetes bind requirements, the production startup matrix, and current transport
  behavior.
- Incorporated Kimi's architecture corrections: authoritative durable resolution decisions,
  same-scope-only uniqueness, explicit recorded/effective-time precedence, deterministic
  legacy collision reconciliation, and a concrete fsync/rename/fsync file snapshot boundary.

### Kimi Review

- One local `kimi-code/k3` architecture turn completed and returned **MODIFY**: the relational
  evidence ledger plus bounded relation projection is the right minimal core, but a
  rebuildable graph projection must never decide conflict suppression, quarantine, access, or
  prompt admission.
- Kimi also rejected an overbroad uniqueness claim, requested explicit bitemporal ordering and
  legacy collision policy, and required the file snapshot to publish heads, idempotency
  operations, and outbox atomically. The architecture document now reflects each point.
- Further Kimi source/test review is not represented as complete. The installed CLI uses the
  external `api.kimi.com` endpoint, and transmitting repository source requires explicit user
  approval after that boundary is disclosed.

### Validation

- Node 20 and Node 22 full unit/integration runs each report 180 outcomes: 179 passed, one
  opt-in ONNX semantic test skipped, zero failed. The final post-review focused suite passes
  82/82.
- TypeScript application and benchmark typechecks, production build, `git diff --check`, and
  quickstart JavaScript syntax pass.
- Embedded MCP end to end passes six-tool discovery, remember/recall/context/feedback,
  restart persistence, supersede, forget, and clean resource release. Hermes Python contracts
  pass 4/4; generated Hermes schemas and both generated benchmark fixtures are byte-stable.
- Postgres reports 31 outcomes: 24 passed and seven pgvector-only cases skipped because the
  locally reachable server has no vector extension. Docker Desktop did not expose a usable
  daemon, leaving the clean pgvector and production-container checks to GitHub CI.
- Internal retrieval gate passes: in-memory R@1 40.9%, R@10 89.8%, MRR 0.615, nDCG@10 0.648.
  Context evidence recall is 0.7692 with no budget violations. Stale-over-current remains
  0.375 and abstention leakage remains 1.0; this slice makes no quality/SOTA claim.

### Handoff / Remaining Gates

- P0-B remains the next implementation slice: V2 evidence/series/version/head tables,
  persisted idempotency, atomic batch ingest, CAS revision, transactional audit/outbox, and
  single-writer crash-safe file snapshots.
- Production-ready remains blocked on durable audit, shared quotas, backup/restore and
  multi-replica drills, representative held-out context quality, pgvector/container CI, and
  the transactional V2 mutation core.
- The authenticated Codex Cloud CLI has no environment for `campaign-layer/memory-core`.
  No task was submitted to an unrelated repository; create/connect that environment or supply
  its environment id before handing this branch to Cloud.

## Run: 2026-08-30 15:31 (IST)

### Scope

Prepare the hardened branch for an honest Product Hunt public-beta launch: provide a short,
reproducible Postgres + pgvector path that demonstrates isolated cross-app memory sharing,
make that exact topology a release gate, remove the remaining default-graph dependency alert,
and separate verified beta readiness from production/SOTA claims.

### Changes

- Added a checked-in Compose stack with Postgres + pgvector, persistent storage, a
  loopback-only host port, and three exact principal grants labelled Claude, Codex, and
  Hermes. The public credentials are explicitly local-demo only.
- Added a dependency-free Node 20+ demo. It proves one credential cannot impersonate another,
  Claude's principal can write actor-scoped evidence, Codex's principal can recall it across
  producer apps, and Hermes's principal receives it in bounded prompt context.
- Bounded readiness to one 60-second operation, bounded each probe to two seconds, retained
  the final diagnostic, and rejected unsupported Node versions immediately.
- Changed the container CI lane from a separate host-network smoke to the exact documented
  Compose bridge topology. CI builds the production image, verifies optional ONNX is absent,
  starts the database and service in dependency order, runs the demo, captures logs, and
  always removes containers, network, and test volume.
- Marked the project as public beta in the README and documented what the demo does and does
  not prove. It exercises the integration identity boundary; it does not launch third-party
  Claude, Codex, or Hermes products.
- Updated `tsx` to 4.23.13 / esbuild 0.28.2. This removes the remaining development-only
  esbuild advisory. The already-updated branch also carries patched body-parser 2.3.0 and
  qs 6.15.3, which are still reported only against the unmerged default branch.

### How It Works Now

1. `docker compose up --build -d` builds memory-core and starts pgvector Postgres behind a
   private Compose network; only memory-core port 7401 is published, on host loopback.
2. Postgres must become healthy before memory-core starts. The local stack applies ordered,
   checksummed migrations and exposes provider-aware readiness.
3. `node examples/shared-agent-demo.mjs` first sends a deliberate cross-app impersonation and
   requires HTTP 403. It then writes, recalls, and assembles context with three distinct keys
   sharing the same tenant/space/actor coordinate.
4. GitHub runs that same path on every push/PR alongside Node 20/22, Postgres+pgvector,
   retrieval/context benchmarks, MCP lifecycle, and Hermes contract gates.

### Files Touched

- `docker-compose.yml` — executable local public-beta topology and bounded demo principals.
- `examples/shared-agent-demo.mjs` — negative authorization plus cross-app write/recall/context
  proof.
- `.github/workflows/ci.yml` — exact Compose end-to-end release gate and cleanup.
- `README.md`, `docs/deployment.md` — beta positioning, runnable commands, and production
  distinctions.
- `package.json`, `package-lock.json` — demo command and patched development runner.
- `docs/CODEX_RUN_SUMMARY.md` — this handoff entry.

### Validation

- Node 20 and Node 22 each report 180 outcomes: 179 passed, one explicitly opt-in ONNX test
  skipped, zero failed. Application/benchmark typechecks, production build, demo syntax,
  Compose config, and `git diff --check` pass.
- `npm audit --omit=optional` and `npm audit --omit=dev --omit=optional` each report zero
  vulnerabilities. The optional local-ONNX dependency graph remains excluded from release.
- GitHub CI run `33305397506` passed all five jobs at commit `84c745d`: Node 20, Node 22,
  deterministic benchmarks, Postgres + pgvector, and the exact production-image Compose
  demo. The container log records Postgres readiness, the expected 403, one created record,
  cross-app recall at score 0.922, Hermes context inclusion, and complete cleanup.
- An independent launch review initially returned no-go because CI tested a different Docker
  topology. After the workflow and claims were corrected, its focused re-review returned GO
  with no merge blocker.
- The production image built locally and its runtime dependency stage audited clean. The
  existing Colima VM then reproduced its containerd metadata I/O corruption while creating a
  database container; clean GitHub infrastructure passed the exact path, so this is recorded
  as a local VM/storage defect rather than an application failure.

### Risks / Follow-ups

- This is suitable for a public beta/developer preview after merging the branch. It is not a
  production-ready or SOTA certification. Transactional V2 revisions/idempotency/audit,
  backup/restore, multi-replica and quota drills, and held-out temporal/abstention quality
  remain required.
- The principal demo and MCP lifecycle verifier cover the service and adapter contracts, but
  a real Claude/Codex/Hermes host pilot is still needed before claiming product-level native
  integration.
- The default branch is not yet updated and there is no tagged release, published image,
  product homepage/live playground, logo, screenshot gallery, or launch video. These are
  launch-distribution gaps, not memory-core correctness gaps.
- `pgvector/pgvector:pg16` remains a mutable convenience tag; pin a tested multi-architecture
  digest for a formal release artifact.
- Kimi's completed architecture verdict remains **MODIFY** and its corrections are in the
  architecture document. Further source/test review still requires explicit approval to send
  relevant repository content to the configured external `api.kimi.com` endpoint.

## 2026-08-30 — exact-framework compatibility and endurance qualification

### Scope

Build a reproducible, fail-closed way to test the real Memory Core service against multiple
agent frameworks on a dedicated bench host, then run a fault-injected canary before starting
a detached 24-hour qualification. Compatibility evidence is graded L0–L3 so accepting a
configuration is never reported as real tool execution.

### Changes

- Added exact-version probes for the MCP TypeScript SDK, LangChain, LangGraph, OpenAI Agents
  MCP, the native OpenAI Agents adapter and real scripted Runner, AutoGen, CrewAI, Claude
  Code, Codex CLI, Hermes, and OpenClaw. The deterministic hosts exercise the complete six-
  tool lifecycle and corroborate state through authenticated REST reads.
- Added a production-shaped, loopback-only Postgres/pgvector Compose stack with a separate
  one-shot migrator, immutable database image requirement for qualified profiles, bounded
  resources/logs, exact principal grants, and source revision/tree labels on the application
  image. Ordinary production Docker builds still work without qualification labels.
- Added a mixed-principal workload, isolation and scope preflights, concurrent dedupe and
  feedback checks, an acknowledged-ID persistence oracle, monotonic timing, throughput and
  scheduler gates, periodic audits, resource samples, and explicit application/database
  restart and SIGKILL recovery tests.
- Added a fail-closed campaign controller. It independently rechecks clean Git source, the
  runtime contract, running image provenance, expected framework versions, scheduled probe
  slots and faults, container generations, resource coverage, final logs, and cryptographic
  artifact completeness. A terminal completion marker is written only after the final
  summary and evidence manifest.
- Added a sanitized review-bundle exporter with a strict allowlist, stable-copy checks,
  streaming hashes, credential-derived secret scanning, and terminal/manifest verification.
  Live credentials, isolated CLI homes, and framework homes are never exportable.
- Disabled host-advertised parallel tool calls for Hermes and OpenClaw while remote
  supersede remains a create-then-retire workflow. Added a regression test and a Node 24 CI
  lane for harness syntax plus fail-closed configuration generation.

### Validation before remote execution

- Node 22.14.0: 181 outcomes, 180 passed, one opt-in ONNX test skipped, zero failed.
- Root typecheck, benchmark typecheck, production build, every JavaScript harness syntax
  check, the Python probe compile check, and `git diff --check` pass.
- The generator's source, bounds, output-containment, version, and Compose contract rejection
  cases were exercised locally. The full Docker/framework/fault path is intentionally left to
  the dedicated Linux bench host and must not be inferred from these local checks.

### Qualification status

The attested bench canary, sanitized Claude Opus adversarial review, and detached 24-hour
primary run are the next gates. Until the canary is green and the primary campaign reports
`PASSED`, this section records implementation readiness only—not framework certification,
production qualification, or SOTA memory quality.

Updated on 2026-08-31: the repaired 900-second canary completed `CANARY_PASSED`; see the next
run entry. The frozen Claude review and 24-hour primary qualification remain open.

Updated on 2026-09-02: the primary workload completed its full 24 hours and passed every
durability, isolation, concurrency, timing, throughput, audit, and injected-fault gate, but
the enclosing campaign correctly finalized `FAILED`, `qualified:false` because all four
periodic L2 framework rechecks failed. See the 2026-09-02 terminal audit below.

### Canary defect and atomic-dedupe repair

- A fresh exact-runtime canary passed all eleven framework startup probes and every runtime
  inventory gate, then failed closed in its concurrency preflight: 20 acknowledged identical
  writes produced three returned/active ids. The run finalized `FAILED`, `qualified:false`,
  with zero isolation violations, zero acknowledged losses, clean final audits, and atomic
  feedback `0 -> 20`. Its 42-file, 1.90 MB sanitized evidence bundle verifies against
  `SHA256SUMS`; it is retained as negative evidence, not launch clearance.
- Replaced Postgres service-level check-then-insert dedupe with a provider-native atomic
  create-or-reinforce operation. Five scope-specific partial unique expression indexes now
  exactly match the tenant/workspace/app/actor/thread visibility identity and use SHA-256;
  normalized-text equality remains a fail-closed collision guard.
- Migration 003 blocks writers, detects hash collisions, deterministically consolidates
  existing active duplicates, merges monotonic fields/metadata/feedback counters, preserves
  losers as superseded audit rows, and builds the invariant without a PostgreSQL 14 heap
  rewrite. Readiness requires all five indexes to be unique, ready, and valid.
- Active-but-logically-expired rows are archived in the same transaction before replacement,
  preserving time/inactivity decay semantics. Deadlock and serialization aborts receive a
  bounded whole-transaction retry; other uniqueness failures remain hard errors, while direct
  exact-dedupe conflicts surface as a typed error.
- The soak oracle now requires one create, nineteen updates, one record per response, one
  returned id, one active id, and an independent exact-text search returning that same durable
  id. It no longer accepts a run merely because only one of several returned ids remains active.
- A frozen local Kimi pass over commit `9f2024f` produced substantive analysis but timed out
  before returning its required final verdict; it is recorded as `TIMED_OUT_NO_FINAL_VERDICT`,
  never as a clearance. Independent verification of its partial findings gave `MODIFY` and led
  to a follow-up patch: readiness now validates table ownership, key shape, hash expression,
  predicate, uniqueness, readiness, and validity; migration work has a 30-second lock timeout
  but no request statement timeout; malformed/missing decay kinds fail migration atomically;
  and `hideExpiredOnRead=false` keeps its former reinforcement semantics.
- Added adversarial coverage for same-named indexes on the wrong table/wrong definition, a
  one-millisecond request timeout around a deliberately slow migration, malformed legacy decay
  rollback, and a two-pool 20-writer race replacing one pre-existing expired memory exactly
  once. Updated the Postgres self-hosting documentation to require migration 003 and distinguish
  the ledger-idempotent runner from non-replayable raw SQL transitions.

Validation after the repair: the fresh-schema Postgres suite reports 42 tests, 35 passed and
seven pgvector-only skips, including seeded legacy-duplicate and invalid-decay migration proofs,
structural readiness sabotage checks, and deterministic two-pool/20-writer regressions for both
an empty key and a pre-existing expired row. The ordinary race returns one id and exact
`created=1`/`updated=19` accounting. The 181-outcome application suite remains
180 passed, one opt-in ONNX skip, zero failed; typechecks, build, harness syntax, and diff checks
pass. The repaired bench canary is now complete; frozen-source Claude Opus review and the
24-hour primary qualification remain mandatory before any production-ready claim.

## Run: 2026-08-31 15:08 (IST)

### Scope

Document the exact framework compatibility evidence, same-harness comparisons with other
memory systems, shared-instance multi-agent semantics, the completed short canary, and a
rigorous path from autonomous L3 tool use to causal O1/O2 agent-outcome evidence.

### Changes

- Added an exact pinned-version framework matrix. Generic MCP, LangChain, LangGraph, both
  OpenAI Agents routes, AutoGen and CrewAI are L2; Hermes/OpenClaw are L1; Claude Code/Codex
  are L0. No route is described as autonomous L3 or task-uplift evidence.
- Added a concise same-harness Memory Core versus supermemory/mem0 table. It reports the
  early-precision losses alongside the retrieval-depth wins and lists unmeasured systems as
  unmeasured instead of borrowing vendor numbers.
- Documented one-instance multi-agent use: distinct credentials and producer apps, explicit
  tenant/space/actor identities, actor/workspace/app/thread sharing patterns, and the boundary
  between shared evidence and task coordination.
- Added `docs/AGENT_EVALUATION.md`: stateless, token-matched transcript, Postgres+BM25,
  Postgres+hybrid, competitor, oracle, read-disabled-placebo and irrelevant-memory arms;
  retrieval-controlled versus end-to-end tracks; sealed paired tasks; L3/O1/O2 evidence;
  a memory-on/off × shared/isolated multi-agent factorial; separate 24-hour quality and
  reliability verdicts; seven-day drift; metrics, statistical treatment and provisional
  release gates.
- Corrected `buildContext` wording from “unmeasured” to its actual state: an internal
  regression exists, but no public end-to-end agent-outcome score exists.
- Recorded the live `CANARY_PASSED` evidence from commit `38a2806`, while stating that its
  terminal bundle remains on the bench host and is not proof contained in this checkout.
- Local Kimi Code 0.32.0 / `kimi-code/k3` completed a frozen, sanitized architecture and
  experiment review with verdict **MODIFY — evidence gap**. Its corrections shaped the
  factorial, inferential unit, task/lease boundary, evidence levels and longitudinal windows.

### How It Works Now

1. Each agent connects through its native adapter or a local stdio MCP proxy to one
   authenticated Memory Core service.
2. Principal configuration fixes tenant, space, app and actor outside model arguments.
   Scopes decide intentional sharing; app/thread memory remains narrow while actor/workspace
   memory can cross agents.
3. Framework support claims stop at the highest observed L0/L1/L2 level for the exact pinned
   version. A real model trace is required for L3.
4. O1 pairs the same sealed single-agent scenario across memory controls and scores objective
   environment outcomes. O2 estimates the shared-memory interaction in multi-agent tasks and
   requires the effect to survive faults, growth and corrections.
5. Memory remains evidence. Claims, leases, work ownership and consensus require separate
   fenced coordination state.

### Files Touched

- `README.md` — public framework/multi-agent status and evaluation links.
- `docs/INTEGRATION_GUIDE.md` — exact support matrix and shared-instance patterns.
- `src/integrations/README.md` — route-specific verified/unverified claims.
- `docs/BENCHMARKS.md` — comparison summary and corrected context-evaluation limits.
- `docs/AGENT_EVALUATION.md` — causal and longitudinal experiment design.
- `docs/ARCHITECTURE.md` — Kimi evidence gap and architecture priorities.
- `bench/framework-compat/README.md` — completed canary summary and claim boundary.
- `docs/CODEX_RUN_SUMMARY.md` — this handoff entry and the repaired-canary status correction.

### Validation

- Application suite: 181 outcomes, 180 passed, one opt-in ONNX case skipped, zero failed.
- Application typecheck, benchmark typecheck and production build pass on Node 22.14.0.
- The deterministic `buildContext` baseline passes and reproduces evidence recall 0.7692,
  all-gold 0.7273, stale-over-current 0.375, abstention leakage 1.0 and zero budget violations.
- All newly quoted supermemory/mem0 retrieval and matched-denominator QA values were checked
  against the committed result artifacts.
- Relative links across the eight affected documentation files, `git diff --check`, and the
  branch-name policy pass.
- Kimi exited 0. Raw review SHA-256:
  `424a55ecfbf77c81edcbb447a688995c42a8391618e4643bc736f3156a0e8c22`;
  independent validation:
  `3f0cad92afbc803ee125632b7d184e868a6c9c6977737705a9c586ef0e91b045`;
  receipt: `f91113a68f9b578b728ada6c880270d8e31716b77bf48dbf7b0d34b3553f59fa`.

### Risks / Follow-ups

- No autonomous L3, causal O1 or multi-agent O2 run has passed; the new gates are a protocol,
  not a result.
- The production-shaped Postgres provider, built-in extractor and hosted reranker still lack
  a matched labeled quality run.
- Direct competitor evidence is limited to supermemory on the internal synthetic suite and
  mem0 OSS 2.0.14 on LoCoMo through our harness.
- The 24-hour primary completed but did not qualify because its periodic L2 framework gates
  failed. Backup/restore, rolling deployment, multi-replica behavior and the seven-day
  quality/drift study remain open.
- Automatic semantic contradiction resolution and transactional remote revision remain open;
  shared memory must not be used as a queue, lock or task lease.

## Run: 2026-09-02 17:26 (WIB)

### Scope

Perform a fresh launch-readiness crawl after the detached 24-hour campaign reached its
terminal state; separate storage/recovery evidence from agent-facing context failures and
probe defects; and recheck the exact pushed revision, CI, build, types, and production
dependency audit.

### Changes

- Recorded the terminal primary campaign as `FAILED`, `qualified:false`; the underlying
  24-hour soak itself returned `PASSED` and failed no storage or operational gate.
- Isolated two distinct periodic-probe findings. Twenty-five of 28 L2 rechecks omitted the
  exact just-written memory from the 1,000-character `build_context` block under the grown
  corpus. Their recall assertions were inconclusive because the same formatted header echoes
  the short query marker. The three "forgotten memory remained visible" failures are likewise
  not evidence of a storage leak: the probe matches that echoed header and skips the
  authoritative REST readback after the false failure.
- No product code changed in this crawl. The launch recommendation is now tied to fixing the
  context-under-growth behavior and the probe assertion before repeating qualification.

### How It Works Now

1. The exact `e730f15` service sustained the configured 24-hour mixed-principal workload.
2. The persistence oracle and final audit independently accounted for every acknowledged
   active record across application/database restart and SIGKILL faults.
3. Startup framework probes passed at their declared L0/L1/L2 levels. At 5, 10, 15, and 20
   hours, every seven-framework L2 batch failed, so the campaign failed closed even though
   the workload process exited successfully.
4. Compatibility and memory quality remain separate claims: the existing protocol paths run,
   but exact-evidence inclusion is not reliable at the probe's aggressive 1,000-character
   budget under this corpus growth, and no autonomous L3 or memory-on/off outcome improvement
   has been demonstrated.

### Files Touched

- `docs/CODEX_RUN_SUMMARY.md` — terminal campaign evidence and corrected launch status.

### Validation

- Remote primary: 242,651 requests, 242,649 successful, two expected fault-window errors,
  34,785 acknowledged writes, five completed audits covering 67,886 record checks, and zero
  unexpected/transport errors, isolation violations, acknowledged losses, unverified audit
  rows, scheduler drops, concurrency failures, or mutation no-ops.
- All four scheduled application/database graceful-restart and SIGKILL faults recovered; the
  final audit accounted for 26,282/26,282 active records with zero lost or unverified.
- Exact dedupe returned one durable id with `created=1`/`updated=19`; atomic feedback reached
  `0 -> 20`. Full duration, target throughput, monotonic timing, source/image provenance,
  resource coverage, and terminal artifact completeness all passed.
- The normal workload's 2,000-character path completed 43,096/43,096 context requests with
  every required marker present; context latency was 34.47 ms p50, 55.87 ms p95, 67.33 ms
  p99, and 184.5 ms maximum. This narrows the periodic failure to retrieval and/or packing
  under the smaller 1,000-character framework-probe budget rather than a general context or
  persistence collapse; the terminal probe artifacts alone did not retain raw hit ranks.
- `HEAD` and `origin/master` both equal `e730f15bd783e2ee8df0a8cea574352ac4e47568` with a clean
  tree, no open pull requests, and green master CI. Application and benchmark typechecks,
  production build, and `git diff --check` pass. The production dependency audit reports zero
  vulnerabilities.
- The local shell is Node 16.20.2, below the declared Node 20 floor, so its fetch-dependent
  test failures are not treated as product regressions; green Node 20/22 GitHub CI covers the
  exact unchanged revision.

### Risks / Follow-ups

- Fix and regression-test query-relevant context selection under large noisy actor corpora;
  then rerun the existing canary and one full 24-hour qualification. Do not add another
  harness for this gate.
- Make framework probes assert structured tool success/data and authoritative record ids,
  never marker substrings in echoed query headers.
- Before a public launch, add at least one real L3 agent pilot and paired memory-on/off outcome
  experiment. Production certification still additionally needs transactional revisions and
  idempotent batches, durable audit/metrics, backup/restore, and multi-replica/rolling-deploy
  drills.
- There is still no repository tag, GitHub release, or published npm package.

## Run: 2026-09-02 21:11 (WIB)

### Scope

Turn the terminal 24-hour failure into a causal fix, make the existing framework campaign's
assertions trustworthy, run independent adversarial reviews, and add a local terminal view
for the parallel work. No new compatibility harness was created.

### Changes

- Reconstructed every one of the 25 genuine context omissions against the preserved campaign
  database. Each target was lexical rank 1/all-terms true but composite rank 3; two verbose,
  higher-prior rows consumed the 1,000-character budget first. The new context selection
  reserves the highest-ranked direct query-containing candidate already inside the provider's
  `maxItems * 2` result set, fills the remaining budget in provider order, and renders the
  final subset in provider order. The hard character bound and complete evidence lines remain
  intact.
- Added `omittedCandidateCount` to distinguish "matching candidates did not fit" from "no
  memory exists". The agent tool now returns a truthful budget-omission message instead of a
  false empty-store claim.
- Hardened the existing JavaScript, Python, and OpenAI Runner probes. Recall checks parse exact
  evidence rows rather than query-echoing headers; superseded/forgotten checks compare exact
  memory text; mutation tools require exact receipts; every recall/context leg rejects tool
  error wrappers; and REST state is checked before the post-forget negative recall assertion.
- Added fail-closed parser/error self-tests to the existing framework CI job and regressions
  for grown noisy corpora, an oversized reserved line, and truthful tool output.
- Added `npm run dashboard:agents -- --watch=2`, backed by Git-ignored local state, to show
  lanes, owners, elapsed time, Git state, and launch gates. It can initialize a fresh state,
  add/update lanes and gates, and render once or continuously.
- Updated the public integration, evaluation, endurance, and working-overview docs so the
  completed storage workload is not presented as a qualified 24-hour framework run.

### How It Works Now

1. Retrieval remains provider-authoritative and fetches at most `maxItems * 2` candidates.
2. Prompt assembly filters unverified evidence, reserves one complete direct-match line when
   it fits, admits other lines under the remaining character/item budget, then restores
   provider order for rendering.
3. Every considered search/profile id not emitted is counted as an omitted candidate. An
   empty context can therefore distinguish budget pressure from an actually empty store.
4. Framework lifecycle evidence is accepted only from exact parsed memory rows plus scoped
   REST corroboration; formatted query headers and error wrappers cannot satisfy absence or
   presence checks.

### Files Touched

- `src/service.ts`, `src/types.ts`, and tests — budget-aware direct-evidence reservation and
  omitted-candidate accounting.
- `src/integrations/tools.ts` and tests — truthful all-omitted response.
- `bench/framework-compat/probe-lib.mjs`, `probe-python.py`, and
  `probe-openai-runner.mjs` — fail-closed exact lifecycle assertions.
- `.github/workflows/ci.yml` — existing-harness parser/error self-tests.
- `tools/orchestration-dashboard.mjs`, `package.json`, and `.gitignore` — local terminal
  dashboard and private transient state.
- `README.md`, `bench/framework-compat/README.md`, `docs/AGENT_EVALUATION.md`,
  `docs/INTEGRATION_GUIDE.md`, `docs/WORKING_OVERVIEW.md`, and this run summary — corrected
  evidence and behavior documentation.

### Validation

- Full application suite on Node 20.19.2 and Node 22.14.0: 184 tests, 183 passed, zero
  failed, one optional ONNX integration skipped on each runtime.
- Application typecheck, benchmark typecheck, production build, all framework `.mjs` syntax
  checks, Python compile, JavaScript/Python adversarial self-tests, dashboard fresh-state and
  mutation smoke checks, `git diff --check`, and production dependency audit all pass. The
  audit reports zero vulnerabilities.
- Preserved-database reconstruction found the exact target at final rank 3 in all 25/25
  failed cases. Each reserved target line plus header is 378–422 characters, so the patch
  would include all 25 under the original 1,000-character budget. This is retrospective
  validation, not a substitute for a fresh live run.
- Kimi CLI 0.32.0 (`managed:kimi-code/k3`) completed two minimized, read-only reviews. The
  initial revision was `BLOCK`; the repair patch was `ADVISORY`. Its final requested error
  guard, truthful all-omitted response, and oversized-line regression are implemented. Receipt
  SHA-256: `91ee61b1930cace5a62c2eb123d37c66fa3432dc91f4496832ccae7de675beef`.
- Claude Opus was `NOT_RUN`: the external export gate stopped before process creation and no
  source was sent to Anthropic. The receipt records that fact; local causal findings must not
  be represented as a Claude verdict.

### Risks / Follow-ups

- A fresh 900-second exact-framework/fault canary and full 24-hour qualification on the
  patched commit are still mandatory. The branch is not production-qualified until both pass.
- Reservation only applies to a direct textual match already inside the provider candidate
  set and only when one complete evidence line fits. It is not graph/multi-hop retrieval,
  token-aware packing, semantic contradiction resolution, or proof of agent task uplift.
- No L3 autonomous host run or paired memory-on/off O1/O2 outcome experiment has passed.
  Backup/restore, rolling deployment, multi-replica behavior, durable audit/metrics, and the
  seven-day quality/drift study remain open production gates.

## Run: 2026-09-03 01:45 (WIB)

### Scope

Make the public provider comparison auditable: distinguish same-harness evidence from vendor
marketing/reference numbers, expose the exact protocol and artifact behind each claim, and
state what still prevents a provider leaderboard claim.

### Changes

- Added a compact Memory Core versus mem0 OSS and supermemory overview to `README.md`. The
  mem0 comparison links directly to the committed LoCoMo retrieval, matched-denominator QA,
  and artifact-index files; both Memory Core wins and mem0 wins remain visible.
- Added a separately labelled vendor-reference table for current Mem0 managed, Supermemory,
  and Zep results. It records retrieval depth, model, context budget, and product-path
  differences and forbids computing deltas against Memory Core from those rows.
- Corrected an overstatement about evidence retention: LoCoMo and LongMemEval result artifacts
  are committed, while the historical synthetic/supermemory raw outputs are not. That
  comparison is now explicitly provisional until a clean credentialed rerun is checked in.
- Documented the minimum contract for a publishable provider leaderboard and added the exact
  commands for the local synthetic, LongMemEval, LoCoMo, mem0, and terminal-summary paths.
- Moved TUI vendor-reference values into `bench/provider-reference.json`, including a review
  date, metric, product path, retrieval budget, and official source URL for each row.
- Corrected `omittedCandidateCount` so it covers retrieval hits and bounded profile candidates
  actually considered for prompt emission, rather than every actor record scanned.

### How It Works Now

1. Results generated under one Memory Core harness are eligible for a direct comparison only
   when corpus, query set, metric implementation, and denominator match.
2. Provider-published results remain reference targets in a separate table; their percentages
   are never subtracted from or ranked beside Memory Core scores.
3. Each public-dataset claim links to a committed JSON/text artifact containing its dataset
   checksum, source revision, command, configuration, and denominator.
4. Missing same-harness provider coverage is reported as `not measured`, and the synthetic
   supermemory result retains its self-authored-dataset and missing-raw-artifact caveats.

### Files Touched

- `README.md` — provider comparison, external references, artifact links, benchmark contract,
  and reproduction commands.
- `bench/provider-reference.json` — dated provenance for non-comparable vendor reference bars.
- `tools/benchmark-tui.mjs` — reads the provenance manifest and labels the full LongMemEval
  row correctly as BM25-only.
- `src/service.ts`, `src/service.test.ts` — bounded omission-count semantics and regression.
- `docs/CODEX_RUN_SUMMARY.md` — this handoff entry.

### Validation

- Every Memory Core/mem0/LongMemEval value in the new overview was checked against
  `bench/locomo/results/mode_a.json`, `bench/locomo/results/oracle_matched.txt`, and
  `bench/longmemeval/results/modeA-fast.json`.
- Mem0 managed, Supermemory, and Zep references were checked against each vendor's official
  benchmark page on 2026-09-03.
- Markdown relative-link validation, `git diff --check`, and `npm run bench:tui` pass. The TUI
  reads the committed LoCoMo/LongMemEval artifacts and renders vendor figures as reference-only
  bars with no cross-protocol delta.
- Node 20 full test suite: 185 tests, 184 passed, 0 failed, 1 optional skip. Runtime and benchmark
  TypeScript checks pass.
- Kimi Code 0.32.0 (`managed:kimi-code/k3`) reviewed commit `534218b` and returned `ADVISORY`
  with no blocker or major finding. Its three minor provenance/display advisories were then
  fixed: exact dataset naming, full UTC capture time, and fail-closed manifest loading.

### Risks / Follow-ups

- The historical synthetic/supermemory raw result files are not committed and came from
  separate invocations on the same fixture; rerun them together on a clean frozen revision
  before treating that row as durable release evidence.
- No same-harness public-dataset comparison exists yet for supermemory, Zep/Graphiti, Letta,
  or LangMem. Credentials and provider adapters are still needed for those rows.
- Retrieval and constrained QA benchmarks do not prove autonomous agent task uplift. The
  paired L3/O1/O2 memory-on/off campaign remains a separate release gate.
