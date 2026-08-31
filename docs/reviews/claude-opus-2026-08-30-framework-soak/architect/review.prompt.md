# Independent architecture review: framework compatibility and endurance harness

Review only the frozen source snapshot at
`/private/tmp/memory-core-claude-opus-framework-architect-20260830/source`.
Do not inspect the live repository or any path outside that snapshot. Do not
write files, run commands, use the network, invoke MCP, or delegate.

## Objective

Memory Core needs honest evidence that exact agent-framework versions can use
its six stdio MCP tools through a shared authenticated Postgres service, and
that the service preserves authorization boundaries and acknowledged records
during a detached 24-hour, multi-principal run with bounded app/database
faults. The eventual campaign runs on a shared Ubuntu/Docker bench host, must
bind only to loopback, must not disturb unrelated workloads, and must preserve
failed state for forensics.

## Required evidence semantics

- L0 is configuration/readback only and is not compatibility.
- L1 is real host connection and exact six-tool discovery; it is not execution.
- L2 is deterministic execution through the exact real host: malformed input,
  remember, recall, context, feedback, supersede, forget, cleanup, and scoped
  REST lifecycle corroboration.
- L3 is an actual model selecting/calling tools and is reported separately.
- A green campaign requires a clean exact source commit, all required framework
  probes at their declared minimum levels, the full configured duration, every
  scheduled fault proven to change process/database generation, readiness
  recovery, completed post-fault acknowledged-ID audit, zero isolation leaks,
  zero losses/unverified audit records, and complete final artifacts.

## Hard constraints

- No secret may appear in process arguments, third-party framework
  environments, transcripts, review bundles, or logs. A framework gets only
  its own scoped principal. Secret state files remain mode 0600 and excluded.
- The supervisor must not auto-restart until campaign/oracle state has durable
  resume semantics. Containers may use their own bounded restart policy.
- Faults may target only this Compose project. No host reboot, clock/network
  mutation, OOM, disk fill, or unrelated-container action.
- The campaign never deletes its Postgres volume.
- Configuration-only and deterministic tests must not be described as
  autonomous agent/model quality.

## Current intended matrix

L2: MCP TypeScript SDK 1.30.0, LangChain MCP adapters 1.1.4, LangGraph 1.4.13,
OpenAI Agents 0.17.0 via MCP, its native Memory Core adapter through the real
Runner with a scripted model, AutoGen 0.7.5, and CrewAI 1.15.18. L1: Hermes
Agent 0.19.0 and OpenClaw 2026.7.1-2. L0 only: Claude Code and Codex CLI unless
their verifier proves more. Full CLI coverage requires Node 24.15+.

## Known product limitations outside this campaign

Remote supersede is two HTTP calls, exact dedupe is check-then-insert, and
multi-observation HTTP ingest is not one transaction. The harness must expose
or limit claims around these; do not assume they are fixed by endurance tests.
No SOTA memory-quality, multi-replica HA, backup/restore, Internet/TLS, or L3
model-selection claim is in scope.

## Review tasks

1. State the evaluated system in one sentence.
2. Trace the causal path from generated principal/config through framework
   discovery/execution, steady load, fault injection, oracle audit, artifact
   collection, and final verdict.
3. Identify state, clock, coordinate-frame, action, retry, interruption,
   partial-run, and failure semantics.
4. Compare at least two plausible campaign architectures, including this
   controller-plus-append-only-evidence design.
5. Try to construct false-pass, false-fail, secret-leak, shared-host-impact,
   and unreproducible-provenance scenarios from exact source lines.
6. List falsifiable acceptance tests and exact deployment/publication blockers.

Return a concise review followed by one JSON object with exactly these top-level
keys: `verdict` (`CLEAR`, `BLOCK`, or `ADVISORY`), `blockers`, `findings`,
`required_tests`, and `claim_limits`. Every blocker/finding must cite snapshot
paths and line numbers. `CLEAR` means only that you found no blocker for this
exact harness claim; it is not proof of correctness.
