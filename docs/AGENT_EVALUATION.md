# Agent outcome evaluation plan

Memory Core has separate evidence for storage correctness, framework compatibility, retrieval
ranking, and operational survival. None of those alone proves that an autonomous agent finishes
more work because it has memory. This plan defines the missing causal and longitudinal tests.

## What is already known

| Question | Current evidence | Current conclusion |
|---|---|---|
| Can the service save and retrieve scoped records? | Unit/Postgres suites plus the six-tool MCP lifecycle | Yes, for the tested single-node providers and identities. |
| Can several pinned agent-framework versions execute the tools? | Exact-version L2 probes for generic MCP, LangChain, LangGraph, OpenAI Agents, AutoGen and CrewAI | The pinned versions pass deterministically. Claude Code and Codex are only L0; Hermes and OpenClaw are L1. |
| Does state survive bounded failures? | A 900-second Postgres canary with four application/database faults | Yes: `CANARY_PASSED`, zero acknowledged loss and zero isolation violations. This is not the 24-hour production qualification. |
| Is retrieval competitive? | Synthetic, LongMemEval_S and LoCoMo runs through our harness | Hybrid retrieval is competitive at depth, but not consistently best at rank 1 or QA accuracy. |
| Does memory improve a real agent's task success? | No paired model-driven memory-on/off experiment | Unknown. Do not infer this from the rows above. |
| Does quality remain useful as memories accumulate and change? | No 7-day or high-noise longitudinal outcome run | Unknown. |

The completed canary used PostgreSQL with extraction and embedding disabled. It proves the
service mechanics, identity boundaries, exact/lexical recall and persistence. It does not
validate the semantic-quality numbers measured with the in-process hybrid configuration.

## Evidence ladder

The framework harness uses these integration levels:

| Level | Claim |
|---|---|
| L0 | An exact host accepts and reads back an isolated configuration. |
| L1 | The real host launches Memory Core and discovers all six tools. |
| L2 | The real host deterministically executes remember, recall, context, feedback, supersede, forget and cleanup, with REST state corroboration. |
| L3 | A named model autonomously selects the right tools and the resulting state change is captured. |

Agent usefulness starts after L3. Add two outcome levels rather than stretching L3:

| Level | Claim |
|---|---|
| O1 | In a paired, randomized experiment, memory improves a single agent's externally scored task outcome over the strongest no-Memory-Core control. |
| O2 | In a paired, randomized experiment, shared memory improves multi-agent outcomes, and that gain persists under accumulation, corrections, restarts and a representative time horizon. |

No framework currently has O1 or O2 evidence. L3 is a prerequisite for an autonomous-agent
claim, but L3 does not imply either outcome level: a model can call the correct tool and still
perform worse because it saved noise, retrieved stale evidence or over-trusted the result.

## Experimental rules

1. **Score environment outcomes, not convincing prose.** Prefer unit tests, exact state,
   hidden facts, file diffs, accepted tickets and other objective checks. If an LLM judge is
   unavoidable, keep the judge fixed, blind it to the arm, publish its prompt and report an
   oracle ceiling. Report categorical/ordinal/continuous agreement with an appropriate
   statistic such as kappa, weighted kappa or ICC rather than assuming the judge is truth.
2. **Use paired runs.** Give every arm the same scenario, model version, tool set, context
   budget and seed where the host supports one. Randomize arm order and create a fresh
   tenant/space for every replicate.
3. **Keep the controller outside the agent.** The controller owns hidden truth, scheduled
   corrections, faults and scoring. The agent cannot write its own labels.
4. **Capture attribution.** Log every memory write, retrieved id, selected context line, tool
   decision and final action. Replay failures with the memory block removed to distinguish a
   memory-caused error from an unrelated model failure.
5. **Freeze provenance.** Record source SHA/tree, model ids, prompts, framework and package
   versions, provider, embedder/extractor/reranker settings, dataset hash and run command.
6. **Never share state between arms.** A shared service is allowed, but every arm and
   replicate needs a distinct tenant or an equivalently hard namespace boundary.
7. **Use the correct inferential unit.** The independent unit is the sealed
   scenario × seed/run (or a predeclared scenario cluster), never a tool call, retrieved hit
   or repeated audit of the same memory.

## Comparison arms

The minimum useful experiment has A, B and C. Add D–H when budget permits. PostgreSQL is the
held-constant production backend for C and D, not a competing retrieval system.

| Arm | Purpose |
|---|---|
| A. Stateless | Current session only. Establishes whether persistence helps at all. |
| B. Rolling transcript/summary | Strong non-memory baseline with the same prompt-token budget. Prevents Memory Core from winning merely by receiving more context. |
| C. Memory Core PostgreSQL + BM25 | Production identity/storage path with lexical retrieval. |
| D. Memory Core PostgreSQL + hybrid | C plus the selected embedder; extractor and reranker remain separate factorial variables. |
| E. External memory system | mem0, supermemory, or another adapter run by us through the same task controller. Never paste a vendor score into this arm. |
| F. Oracle context | Gold evidence under the same token budget. Separates reader/reasoning errors from memory errors. |
| G. Read-disabled placebo | Perform and charge writes, but expose no retrieved memory. Detects effects caused by workflow/tool overhead rather than recalled evidence. |
| H. Irrelevant-memory safety | Supply plausible but irrelevant stored evidence. Measures whether memory availability itself causes over-trust. |

Do not change several features at once and call the result an architecture win. Test
embedding, extraction, reranking, resolver/versioning and graph/multi-hop retrieval as
separate ablations before combining the winners.

Run two distinct tracks:

- **Retrieval-controlled:** the controller writes the same canonical memory events, scopes
  and timestamps into every system. This isolates storage/retrieval/context selection.
- **End-to-end:** every system receives the same raw turns and owns its capture, extraction,
  update and retrieval policy. This measures the product but cannot attribute a gain to the
  retriever alone.

Never mix rows from those tracks. Charge transcript summarization, hosted extraction,
embedding, reranking and judge calls to the arm that uses them.

## Workloads

### 1. Short causal pilot

Use sealed scenarios across repeated seeds/runs. A planning target of roughly 30 paired
scenario-runs per primary cell is acceptable for the pilot only; the final held-out sample
must be powered from the pilot's paired variance, event rate, clustering and interaction
effects. Each scenario has two to five sessions and one delayed dependency:

- a durable preference needed in a later decision;
- a project decision needed to modify code or an artifact;
- a tool failure whose workaround should be reused;
- an explicit correction that must replace stale information;
- an absent fact where the agent must abstain rather than invent;
- a memory containing prompt-injection text that must remain untrusted evidence.

This pilot estimates variance and failure rates. Use it for power analysis; do not tune on it
and then report the same cases as a held-out result.

### 2. Framework L3 matrix

For each claimed framework, run a real model in an isolated home against the same scenarios.
Require captured model/tool traces and REST corroboration. Measure separately:

- whether the model called `build_context` when prior state was necessary;
- whether it called `remember` only for durable information;
- whether corrections used `supersede` rather than creating an unresolved contradiction;
- whether retrieved evidence changed the final action correctly;
- unnecessary memory calls, loops and malformed arguments.

Start with OpenAI Agents, because its deterministic L2 runner already exists. Then add Claude
Code, Codex, Hermes and OpenClaw. Configuration acceptance or tool discovery is not an L3
pass.

### 3. Multi-agent handoff experiment

Use one Memory Core service with planner, implementer and reviewer principals. Give them
distinct credentials and `appId` values, one explicit shared task space, and private
app/thread scratch scopes. Test both of these intentionally different designs:

- **One user, several assistants:** same tenant, space and actor; actor-scoped facts should
  cross applications.
- **A team of role agents:** same tenant and space, distinct actors; workspace-scoped facts
  should cross actors while actor/app/thread memories remain private.

Scenarios must cover handoffs, simultaneous exact writes, incompatible proposed decisions,
stale corrections, a noisy writer, a malicious writer and one agent going offline. Compare
shared Memory Core with explicit handoff messages under the same token budget.

Memory Core is not a queue, lock manager or task scheduler. A successful experiment must not
depend on a memory write acting as exclusive ownership of work. Claims, leases and ownership
must live in separate fenced coordination state with an expiry and monotonic fencing token.

Use a `memory {off,on} × topology {isolated,shared}` factorial. “Isolated” agents receive the
same explicit handoff payload but cannot read one another's memory; “shared” agents use the
scopes above. The O2 effect is the paired interaction attributable to shared memory, not the
raw success rate of the shared arm.

### 4. Twenty-four-hour operational plus quality run

Extend the existing fault campaign rather than replacing it. Keep the current persistence,
isolation, throughput and resource gates, then schedule hidden outcome episodes throughout
the day:

- recurring tasks whose relevant fact was written hours earlier;
- corrections before and after application/database faults;
- noise growth and adversarial irrelevant memories;
- multi-agent handoffs during and after recovery;
- periodic held-out queries that measure retrieval and context quality, not only record
  existence.

The 24-hour run answers whether short-run usefulness survives faults and accumulation. A
green API soak without these episodes remains operational evidence only. Emit separate
quality and reliability verdicts/artifacts even when faults and outcome episodes share the
same run; neither verdict may mask a failure in the other.

### 5. Seven-day aging and drift run

Use real wall time for scheduler/restart behavior and a controlled logical clock for long TTL
and historical scenarios. Inject daily preference changes, project revisions, duplicate
paraphrases, inactive threads and irrelevant memories. Measure whether stale evidence,
latency, context size and storage grow monotonically. Compare repeated measures from days
1–2 with days 5–7; a week-over-week comparison requires a 14-day run. Include backup/restore
and at least one rolling deployment before calling the run O2 evidence.

## Metrics

### Primary outcome

`task_success`: an externally checkable binary or bounded score defined before the run. The
main result is the paired difference between Memory Core and the strongest control, with a
95% confidence interval.

### Memory quality

- write precision/recall against durable facts in the scenario;
- context evidence precision/recall and rank of the evidence that caused the answer;
- stale-fact use, contradiction detection and correction success;
- abstention accuracy when the answer is absent;
- memory-caused error rate from counterfactual replay;
- repeated-question and repeated-mistake rate;
- useful/unnecessary/missing memory-tool calls.

### Multi-agent correctness and safety

- handoff success and time-to-completion;
- duplicate/conflicting active heads per logical fact;
- provenance accuracy by producing `appId` and actor;
- intended cross-agent share precision/recall;
- forbidden cross-tenant/space/actor/app/thread disclosures—this gate is always zero;
- acknowledged-write loss and unverified audit records—also always zero.

### Efficiency and operations

- input/output/context tokens and cost per successful task;
- write, recall, context-build and end-to-end latency percentiles;
- memory count, index size and candidate count over time;
- error, retry, scheduler-drop and fault-recovery rates;
- application/database CPU, memory and disk behavior.

## Statistical design and provisional gates

- Block by scenario and seed; analyze paired outcomes. Use McNemar's test or an exact paired
  interval for binary success, and paired bootstrap intervals for continuous metrics.
- Choose one primary outcome and one primary comparison before running. Treat framework,
  task-family and configuration slices as secondary unless powered independently.
- Run a pilot, estimate the observed paired variance, and calculate the held-out sample size.
  Estimate cluster/interaction effects for multi-agent cells. Do not declare that 30 or 50
  scenarios are universally sufficient.
- Publish failures and confidence intervals, not only point estimates. Correct for multiple
  comparisons when selecting among several configurations; use Holm adjustment for the
  predeclared secondary family unless the protocol justifies another method.

Provisional O1 release gates, to be frozen after the pilot:

1. The lower bound of the 95% paired interval for task-success uplift over the strongest
   token-matched control is above zero, with a target point improvement of at least ten
   percentage points.
2. The upper bound of the one-sided 95% interval for the increase in memory-caused severe
   errors is no more than one percentage point versus the control; absolute stale-fact action
   is at most 5% and harmful-memory action is below 1%.
3. Every framework included in the outcome claim reaches L3 on the held-out scenarios.
4. There are zero scope-isolation violations, zero acknowledged-write losses and zero
   unverifiable terminal audits.
5. Cost per successful task rises by no more than 20% versus the strongest control. If a
   different budget is justified after the pilot, preregister it before unblinding.

O2 additionally requires the O1 effect to survive the 24-hour and seven-day workloads,
faults, state growth, corrections and multi-agent contention. Candidate 24-hour gates are a
15-point shared-memory handoff interaction with a 95% interval above zero, no silent
old-over-new action, every detected conflict surfaced, and total task success within a
preregistered noninferiority margin. Candidate seven-day gates are at least 30% lower repeat
error in days 5–7 than days 1–2, poison execution below 2%, correction propagation by the
next episode, zero isolation/loss, and p95/p99 latency plus storage growth within declared
limits. Pilot data must validate or revise these thresholds before a confirmatory run.

## Turning failures into architecture work

| Failure | Likely improvement |
|---|---|
| The agent never writes a needed fact | Better tool policy or measured extraction. |
| The fact exists but is not retrieved | Embedder/fusion/reranker calibration; then multi-hop retrieval where the task requires joins. |
| Old and new facts are both used | Transactional version/current-head model plus contradiction resolution. |
| Correct evidence is retrieved but ignored | Context framing, citations, ordering, calibrated answerable/abstain/conflict state and token-aware budgeting. |
| Agents overwrite or duplicate coordination state | Immutable evidence plus series/version/head CAS for memory, and a separate fenced task/lease coordinator—not graph edges alone. |
| Irrelevant memories accumulate | Write precision, consolidation/decay and better abstention calibration. |
| Private memory crosses a boundary | Stop the run; fix identity/scope enforcement before any quality tuning. |

Use this taxonomy in every report. “The agent failed” is not actionable until the trace says
whether capture, storage, retrieval, context selection, model reasoning or actuation failed.

## Highest-leverage architecture work

The experiment program should drive implementation in this order unless measured failures
say otherwise:

1. Immutable evidence linked to a logical series, explicit versions/current head, and a
   compare-and-swap revision command.
2. Conservative contradiction detection that surfaces `conflict` instead of silently
   merging or letting timestamp order decide truth.
3. A calibrated `answerable | abstain | conflict` decision separate from retrieval rank.
4. First-class memory-use → action → outcome attribution events with redaction and retention
   controls.
5. Role-aware write policies for shared spaces and a separate fenced task/lease API for
   coordination.

A graph or relation projection may help multi-hop retrieval, but it must remain rebuildable
from evidence and must not decide prompt visibility, truth, task ownership or consensus.

## Reproducible artifacts

Each run should emit a sanitized manifest, arm assignment, scenario/seed, exact versions,
model parameters, memory call trace, retrieved/selected ids, objective outcome, attribution
replay, cost/latency metrics and a checksum manifest. Raw credentials and provider secrets
must stay outside the bundle. The existing framework campaign's fail-closed completion marker
and exporter are the starting point for this format.
