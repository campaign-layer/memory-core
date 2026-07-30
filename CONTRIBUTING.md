# Contributing

Thanks for looking. This is a pre-1.0 project with measured, unflattering benchmarks; the
most valuable contributions are the ones that move a number, and the second most valuable are
the ones that make a claim in the docs true.

## Setup

```bash
git clone https://github.com/campaign-layer/memory-core
cd memory-core
npm install
npm run dev        # http://localhost:7401
```

Node 18+ is required; CI runs 20 and 22.

## Checks

Run these before opening a pull request.

```bash
npm run typecheck   # tsc --noEmit. Must pass.
npm test            # node:test. Must pass, with 1 skipped (ONNX, opt-in below).
npm run build       # tsc -> dist/. Must pass.
```

The one skipped test is the ONNX embedder integration case, gated behind
`RETRIEVAL_ONNX_TEST=1` so CI does not download a model. Run it locally with:

```bash
RETRIEVAL_ONNX_TEST=1 npx tsx --test src/retrieval/embedder.test.ts
```

Postgres provider tests need a reachable database with pgvector:

```bash
docker run -d --name mc-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=memory -e POSTGRES_DB=memory_core pgvector/pgvector:pg16
MEMORY_PG_URL=postgres://postgres:memory@localhost:5432/memory_core npm run test:pg
```

`npm run bench:typecheck` currently **fails**, with every error in `src/**`. `bench/tsconfig.json` sets
`noUncheckedIndexedAccess: true` and includes `../src/**/*.ts`, which the root
`tsconfig.json` does not, so the errors are pre-existing `src` code surfaced by the stricter
flag. The bench harness itself is clean. Fixing this is a welcome contribution; do not treat
it as a regression you caused.

## Benchmarks

The synthetic harness lives in [`bench/`](bench/README.md) and runs from a clean checkout —
fixtures are committed, and the same `--size` and `--seed` regenerate a byte-identical
corpus.

```bash
# BM25-only
npx tsx bench/run.ts --systems=random,bm25,in-memory --size=small --k=10

# hybrid (downloads a ~35 MB ONNX model on first run, then offline)
MEMORY_EMBEDDER=local MEMORY_RRF_K=5 \
  npx tsx bench/run.ts --systems=random,bm25,in-memory --size=small --k=10

# live third-party comparison
SUPERMEMORY_API_KEY=... npx tsx bench/run.ts --systems=supermemory --size=small --k=10
```

`MEMORY_EMBEDDER` and `MEMORY_RRF_K` are read by the provider-backed bench systems, so a
sweep needs no rebuild. `--embedder=hash|bench-hash|minilm` selects the embedder for the
`naive-rag` control only.

The LongMemEval and LoCoMo harness is **not in this repository**. Those numbers are reported
in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) but cannot currently be reproduced from this
checkout. Open-sourcing that harness is the top documentation gap.

### Rules for shipping a number

These are not style preferences. This repository previously published a fabricated benchmark
score, and these rules exist so that cannot recur.

1. **Every compared row comes from one harness**, one corpus, one metric definition, one
   denominator. If two rows come from separate invocations, say so where the table is, and
   show that the shared `random` control matched.
2. **Give the command.** A number with no reproduction command does not ship.
3. **Never place a third party's published score in a table beside ours.** External figures
   belong in prose, attributed. Public datasets run through our harness are ours to publish
   only with the caveat that the retrieval granularity, reader and judge are ours and the
   numbers are not comparable to any leaderboard.
4. **Run the `random` control every time.** It runs automatically whether or not you ask for
   it. A system that does not clear it is flagged `!! AT/BELOW RANDOM`, and that flag goes in
   the write-up.
5. **Pair the metrics that mean nothing alone.** `staleRate` with `R@10`; `FPR@tau` with
   `keep@tau`; quality with cost.
6. **Name the dataset honestly.** `memory-core-internal-retrieval` is synthetic and authored
   here. It is not LongMemEval, not LoCoMo, not any published suite.
7. **No domain-specific vocabulary in ranking code.** Gazetteers and answer keys are banned;
   `bench/dataset/spec.ts` asserts against the specific tokens that were removed. See
   [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#non-negotiables).

## Adding a provider

1. Implement `MemoryProvider` from `src/provider.ts` — every required method.
2. Add the kind to `MemoryProviderKind` in `src/providers/factory.ts` and branch in
   `createMemoryProvider`.
3. Add the kind to `PROVIDER_KINDS` in `src/config.ts`. The `satisfies` + `AssertNever` pair
   there makes the build fail if you forget.
4. **Enforce `tenantId` and `appId` on every read.** Throw on an unscoped query; never return
   everything. One missed check is a cross-tenant leak.
5. Register it in `bench/systems/index.ts` and run the harness before and after, including
   the `random` control. No retrieval claim ships without that.
6. Document the storage model and the scoring formula in
   [`docs/providers.md`](docs/providers.md).

## Adding an embedder

1. Implement `EmbeddingProvider { id, dims, embed(texts) }` in `src/retrieval/embedder.ts`.
   L2-normalize the output; the fusion layer assumes cosine over unit vectors.
2. Add the kind to `EmbedderKind` and branch in `createEmbedder`.
3. Add it to `EMBEDDER_KINDS` in `src/config.ts` — same compile-time exhaustiveness guard.
4. If it exceeds 2000 dimensions, check the pgvector HNSW path: above that cap the Postgres
   migration indexes a `halfvec` cast, and `memory_core_embedding_ops_note(dims)` must agree
   with the query side.
5. Label it accurately. `HashEmbedder` is documented as *lexical, not semantic*, because
   cosine over feature hashes measures token overlap. Do not describe a hash as an encoder.

## How the pieces fit

- **Write path** — `MemoryCoreService.ingest`: normalize → `findDuplicate` (exact normalized
  text) → insert or merge. That is the whole resolution stage today.
- **Read path** — `search`: hard filters (tenant, app, actor, thread, type, scope, metadata)
  → provider ranking → `minScore` gate → sort → slice.
- **Context** — `buildContext`: `search` → greedy selection under a character budget →
  prepend a profile summary.

Both paths are written up in detail in
[`docs/WORKING_OVERVIEW.md`](docs/WORKING_OVERVIEW.md), and the reasons the current shape is
wrong are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Read the latter before proposing
a retrieval change — the structural moves it describes are the intended direction, and a
patch that entrenches the current shape is harder to accept than one that moves toward it.

## Pull requests

- Keep the change focused; a retrieval change and a refactor in one PR cannot be reviewed.
- If you touch ranking, include before/after harness output with the `random` control.
- If you change behaviour that a doc describes, update the doc in the same PR. Docs
  describing code that does not exist is the specific failure mode this repository is
  recovering from.
- No AI attribution in commit messages, PR bodies, or generated docs.

## Reporting a security issue

Do not open a public issue for a vulnerability. Note the known limitations first — API keys
are not scoped to a tenant, the rate limiter is per-process, there is no CORS policy and no
security headers, and key comparison is not constant-time. These are documented in
[`docs/deployment.md`](docs/deployment.md#limits-to-know-before-you-deploy) and are not news.
