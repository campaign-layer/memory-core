# Benchmarks

How to benchmark `memory-core` consistently across providers and orchestration frameworks.

## What is measured

Per scenario:
1. ingest
2. context build
3. search
4. feedback

Reported:
1. mean/p95 latency per step
2. end-to-end total latency
3. throughput (scenarios/sec)

## Run commands

In-memory baseline:

```bash
cd memory-core
MEMORY_PROVIDER=in-memory npm run bench:frameworks -- --scenarios=300 --warmup=25 --frameworks=direct,langchain
```

Mem0 provider:

```bash
cd memory-core
MEMORY_PROVIDER=mem0 MEM0_INFER=false MEM0_TELEMETRY=false npm run bench:frameworks -- --scenarios=300 --warmup=25 --frameworks=direct,langchain
```

## Read results correctly

1. Compare direct vs langchain with the same provider to isolate orchestration overhead.
2. Compare providers with the same framework and scenario count to isolate backend cost.
3. For production decisions, include retrieval-quality metrics, not just latency.

## Latest local run

Date: `2026-03-09`  
Command shape:

```bash
npm run bench:frameworks -- --scenarios=300 --warmup=25 --frameworks=direct,langchain
```

### In-memory provider (`MEMORY_PROVIDER=in-memory`)

1. `direct-core-runner`
   - throughput: `4761.9/s`
   - total latency: mean `0.21ms`, p95 `1ms`
2. `langchain-runnable-sequence`
   - throughput: `3614.46/s`
   - total latency: mean `0.27ms`, p95 `1ms`

### Mem0 provider (`MEMORY_PROVIDER=mem0`, `MEM0_INFER=false`)

1. `direct-core-runner`
   - throughput: `15.86/s`
   - total latency: mean `63.05ms`, p95 `98ms`
2. `langchain-runnable-sequence`
   - throughput: `13.67/s`
   - total latency: mean `73.17ms`, p95 `122ms`

### Summary

1. Orchestration overhead (direct vs langchain) is secondary.
2. Provider backend choice dominates latency and throughput.
3. In-memory is useful for local/dev speed; Mem0 is heavier but semantic.
