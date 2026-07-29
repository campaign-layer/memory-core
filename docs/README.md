# memory-core docs

`memory-core` is an HTTP + MCP memory service for AI agents: ingest typed observations,
retrieve them by query, build a prompt-ready context block. Pluggable storage behind one
provider interface — `in-memory` (default), `file`, `enhanced`, `dual-layer`, `postgres`.

Pre-1.0. Retrieval quality is measured, and the measurements are not flattering.

## Read in this order

1. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — what is structurally wrong with the current
   design and the target shape. Start here; everything else is downstream of it.
2. **[BENCHMARKS.md](./BENCHMARKS.md)** — the retrieval harness, metric definitions, and the
   current numbers. Read the caveats before quoting anything.
3. **[WORKING_OVERVIEW.md](./WORKING_OVERVIEW.md)** — routes, request pipeline, write path,
   read path.
4. **[providers.md](./providers.md)** — every backend, its scoring formula, and its measured
   quality.
5. **[INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md)** — integrating from an app.
6. **[PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md)** — what is in place and what is
   missing.
7. **[deployment.md](./deployment.md)** — configuration, Docker, Kubernetes, troubleshooting.

Outside this directory:

- **[../bench/README.md](../bench/README.md)** — benchmark dataset design, the six task
  families, label-integrity checks.
- **[../src/integrations/README.md](../src/integrations/README.md)** — MCP server, the six
  tools, Anthropic/OpenAI tool use, OpenClaw, Hermes, and an explicit verified/not-verified
  list.

## Headline findings

From `npx tsx bench/run.ts --systems=random,bm25,in-memory,file,enhanced,dual-layer,naive-rag --size=small --k=10`
on `memory-core-internal-retrieval` v1.0.0 — a **synthetic dataset authored in this repo,
not LongMemEval and not LoCoMo**, so these numbers are not comparable to published scores:

- A plain **BM25 lexical baseline beats every provider on `R@10` (92.0%)**. Nothing here
  currently earns its complexity over lexical matching on this dataset.
- The **`enhanced` provider is the worst real system** (`R@10` 38.6%) and ~34x slower than
  `in-memory`, despite older docs calling it "Production Ready".
- Against **live supermemory** we tie on `R@10` and `R@1` and **lose on mid-rank ordering**.
- **Every system fails knowledge-update**, including supermemory. That is an open problem.

Retracted: earlier docs claimed 27.9% on LongMemEval. That claim was invalid — the provider
hardcoded the benchmark's gold answers — and **LongMemEval has never been run in this repo**.
See [BENCHMARKS.md](./BENCHMARKS.md).
