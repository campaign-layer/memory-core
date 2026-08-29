# memory-core docs

Index. Start at the [repository README](../README.md) for what the project is, the quickstart,
and the headline numbers.

## Read in this order

1. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — what is structurally wrong with the current
   design, the verified production gap register, and the evidence-ledger/current-head target
   shape. This is the strategic document; everything else is downstream of it.
2. **[BENCHMARKS.md](./BENCHMARKS.md)** — every harness, every metric definition, full
   results for the synthetic suite, LongMemEval and LoCoMo. Read the caveats before quoting
   anything: all of it is our harness, none of it is comparable to a published leaderboard,
   and reproducing the public-dataset numbers requires downloading those datasets yourself.
3. **[WORKING_OVERVIEW.md](./WORKING_OVERVIEW.md)** — the request pipeline, the write path
   and the read path.
4. **[providers.md](./providers.md)** — every backend, its scoring formula, and its measured
   quality.
5. **[INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md)** — integrating from an application and
   connecting Claude, Codex, and Hermes to one local shared service.
6. **[deployment.md](./deployment.md)** — secure local self-hosting, configuration, the
   operational gap list, Docker, Kubernetes, and troubleshooting.

Outside this directory:

- **[../CONTRIBUTING.md](../CONTRIBUTING.md)** — tests, benchmarks, adding a provider or an
  embedder, and the rules for shipping a number.
- **[../bench/README.md](../bench/README.md)** — synthetic dataset design, the six task
  families, label-integrity checks.
- **[../src/integrations/README.md](../src/integrations/README.md)** — MCP server, the six
  tools, Anthropic/OpenAI tool use, OpenClaw, Hermes, and an explicit verified/not-verified
  list.
