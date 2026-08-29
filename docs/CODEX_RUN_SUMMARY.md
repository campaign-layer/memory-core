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
- GitHub CI, Postgres migration/load, multi-replica chaos, backup/restore, distributed quota,
  audit export, and held-out abstention/temporal targets remain release gates.
