#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

process.umask(0o077);

const baseUrl = required("MC_BASE_URL").replace(/\/$/, "");
const runId = required("MC_RUN_ID");
const runDir = path.resolve(required("MC_RUN_DIR"));
const durationSeconds = numberEnv("MC_DURATION_SECONDS", 86_400, 60, 604_800);
const targetRps = numberEnv("MC_RPS", 2, 1, 100);
const maxConcurrency = numberEnv("MC_CONCURRENCY", 4, 1, 64);
const requestTimeoutMs = numberEnv("MC_REQUEST_TIMEOUT_MS", 10_000, 1_000, 60_000);
const wallClockJumpToleranceMs = numberEnv("MC_WALL_CLOCK_JUMP_TOLERANCE_MS", 5_000, 1_000, 60_000);
const principals = JSON.parse(required("BENCH_PRINCIPALS_JSON"));
if (!Array.isArray(principals) || principals.length < 2) {
  throw new Error("BENCH_PRINCIPALS_JSON must contain at least two principals");
}

await mkdir(runDir, { recursive: true, mode: 0o700 });
const events = createWriteStream(path.join(runDir, "requests.ndjson"), { flags: "a", mode: 0o600 });
const oracleEvents = createWriteStream(path.join(runDir, "oracle.ndjson"), { flags: "a", mode: 0o600 });
const processStartedAtMs = Date.now();
const processStartedAtPerformance = performance.now();
const durationMs = durationSeconds * 1000;
const configuredTargetOperations = Math.floor(durationSeconds * targetRps);
const minimumTargetRpsRatio = 0.95;
const maximumSchedulerDropRatio = 0.01;
const latencies = new Map();
const counters = {
  requests: 0,
  passed: 0,
  unexpected: 0,
  expectedDenied: 0,
  transportErrors: 0,
  faultWindowErrors: 0,
  isolationViolations: 0,
  acknowledgedWrites: 0,
  acknowledgedLosses: 0,
  audits: 0,
  auditsCompleted: 0,
  auditRecords: 0,
  auditUnverified: 0,
  schedulerDrops: 0,
  concurrencyFailures: 0,
};
const statusCounts = {};
const opCounts = {};
const recentUnexpected = [];
const activeOracle = new Map();
const oracleByPrincipal = principals.map(() => []);
const concurrencyResults = {};
const workloadMetrics = {
  configuredTargetOperations,
  scheduled: 0,
  started: 0,
  completed: 0,
  auditPaused: 0,
  schedulerDrops: 0,
};
let sequence = 0;
let inFlight = 0;
let stopping = false;
let stoppedAtPerformance = null;
let workloadStartedAtMs = null;
let workloadStartedAtPerformance = null;
let deadlinePerformance = null;
let deadlineAtMs = null;
let phase = "PREPARING";
let hardStopReason = null;
let lastAuditRequest = "";
let lastCompletedAuditRequest = "";
let lastRequestedAudit = null;
let activeAudit = null;
let lastCompletedAudit = null;
let queuedAudits = 0;
let auditBarrierDepth = 0;
let auditChain = Promise.resolve();
let heartbeatChain = Promise.resolve();
let atomicWriteSequence = 0;
const clockState = {
  lastSkewMs: 0,
  maxAbsoluteSkewMs: 0,
  jumpDetected: false,
  jumpDetectedAt: null,
};
let scheduler;
let heartbeatTimer;
let auditTimer;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function identity(principal) {
  return {
    tenantId: principal.tenantId,
    spaceId: principal.spaceId,
    appId: principal.appId,
    actorId: principal.actorId,
  };
}

function principalLabel(index) {
  const item = principals[index];
  return `${item.tenantId}/${item.spaceId}/${item.actorId}/${item.appId}`;
}

function append(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 100) / 100;
}

function statsSnapshot() {
  const operations = {};
  for (const [op, values] of latencies) {
    operations[op] = {
      ...opCounts[op],
      p50Ms: percentile(values, 0.50),
      p95Ms: percentile(values, 0.95),
      p99Ms: percentile(values, 0.99),
      maxMs: values.length ? Math.round(values.reduce((max, value) => Math.max(max, value), 0) * 100) / 100 : null,
    };
  }
  return operations;
}

function monotonicElapsedMs() {
  return Math.max(0, performance.now() - processStartedAtPerformance);
}

function qualificationElapsedMs() {
  if (workloadStartedAtPerformance === null) return 0;
  return Math.max(0, (stoppedAtPerformance ?? performance.now()) - workloadStartedAtPerformance);
}

function markStopping() {
  if (stoppedAtPerformance === null) stoppedAtPerformance = performance.now();
  stopping = true;
}

function observeClock() {
  const wallNowMs = Date.now();
  const elapsedMonotonicMs = monotonicElapsedMs();
  const elapsedQualificationMs = qualificationElapsedMs();
  const expectedWallNowMs = processStartedAtMs + elapsedMonotonicMs;
  const skewMs = wallNowMs - expectedWallNowMs;
  const absoluteSkewMs = Math.abs(skewMs);
  clockState.lastSkewMs = skewMs;
  clockState.maxAbsoluteSkewMs = Math.max(clockState.maxAbsoluteSkewMs, absoluteSkewMs);

  if (!clockState.jumpDetected && absoluteSkewMs > wallClockJumpToleranceMs) {
    clockState.jumpDetected = true;
    clockState.jumpDetectedAt = new Date(wallNowMs).toISOString();
    append(events, {
      at: clockState.jumpDetectedAt,
      monotonicMs: Math.round(elapsedMonotonicMs * 100) / 100,
      op: "wall-clock-jump",
      skewMs: Math.round(skewMs),
      toleranceMs: wallClockJumpToleranceMs,
    });
    void hardStop(
      `wall clock diverged from monotonic time by ${Math.round(skewMs)}ms `
      + `(tolerance ${wallClockJumpToleranceMs}ms)`,
    );
  }

  return {
    elapsedMonotonicMs,
    elapsedQualificationMs,
    elapsedSeconds: Math.floor(elapsedQualificationMs / 1000),
    remainingMs: Math.max(0, durationMs - elapsedQualificationMs),
    configuredDurationMs: durationMs,
    qualificationStarted: workloadStartedAtPerformance !== null,
    fullConfiguredDuration: elapsedQualificationMs >= durationMs,
    wallElapsedMs: wallNowMs - processStartedAtMs,
    wallClockSkewMs: skewMs,
    maxAbsoluteWallClockSkewMs: clockState.maxAbsoluteSkewMs,
    wallClockJumpToleranceMs,
    wallClockJumpDetected: clockState.jumpDetected,
    wallClockJumpDetectedAt: clockState.jumpDetectedAt,
  };
}

function workloadSnapshot(timing) {
  const achievedRps = workloadMetrics.completed / durationSeconds;
  const targetRpsAchievementRatio = achievedRps / targetRps;
  const schedulerDropRatio = workloadMetrics.scheduled === 0
    ? 0
    : workloadMetrics.schedulerDrops / workloadMetrics.scheduled;
  const auditPausedRatio = workloadMetrics.scheduled === 0
    ? 0
    : workloadMetrics.auditPaused / workloadMetrics.scheduled;
  const accountedSchedules = workloadMetrics.started
    + workloadMetrics.auditPaused
    + workloadMetrics.schedulerDrops;
  return {
    ...workloadMetrics,
    elapsedMs: timing.elapsedQualificationMs,
    achievedRps,
    targetRpsAchievementRatio,
    minimumTargetRpsRatio,
    minimumCompletedOperations: Math.ceil(configuredTargetOperations * minimumTargetRpsRatio),
    schedulerDropRatio,
    maximumSchedulerDropRatio,
    auditPausedRatio,
    accountedSchedules,
    schedulingAccountingBalanced: accountedSchedules === workloadMetrics.scheduled,
  };
}

async function atomicJson(name, value) {
  const target = path.join(runDir, name);
  const temporary = `${target}.${process.pid}.${++atomicWriteSequence}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function faultState() {
  try {
    return JSON.parse(await readFile(path.join(runDir, "fault-state.json"), "utf8"));
  } catch {
    return { active: false };
  }
}

async function request({ op, principalIndex, apiKeyOverride, method = "POST", endpoint, body, expected = [200], purpose }) {
  const principal = principalIndex === null ? null : principals[principalIndex];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const start = performance.now();
  let response;
  let parsed;
  let errorMessage;
  try {
    response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(apiKeyOverride !== undefined
          ? { "x-api-key": apiKeyOverride }
          : principal ? { "x-api-key": principal.key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = { invalidJson: true, preview: raw.slice(0, 200) };
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = performance.now() - start;
  const timing = observeClock();
  const fault = await faultState();
  const status = response?.status || 0;
  const ok = expected.includes(status);
  counters.requests += 1;
  statusCounts[status] = (statusCounts[status] || 0) + 1;
  opCounts[op] ||= { requests: 0, passed: 0, unexpected: 0 };
  opCounts[op].requests += 1;
  if (!latencies.has(op)) latencies.set(op, []);
  latencies.get(op).push(latencyMs);
  if (ok) {
    counters.passed += 1;
    opCounts[op].passed += 1;
    if (expected.some((candidate) => candidate === 401 || candidate === 403 || candidate === 429)) {
      counters.expectedDenied += 1;
    }
  } else if (fault.active) {
    counters.faultWindowErrors += 1;
  } else {
    counters.unexpected += 1;
    opCounts[op].unexpected += 1;
    recentUnexpected.push(performance.now());
    if (!response) counters.transportErrors += 1;
  }
  const recentCutoff = performance.now() - 300_000;
  while (recentUnexpected.length && recentUnexpected[0] < recentCutoff) {
    recentUnexpected.shift();
  }
  append(events, {
    at: new Date().toISOString(),
    monotonicMs: Math.round(timing.elapsedMonotonicMs * 100) / 100,
    op,
    purpose,
    principal: principalIndex === null ? null : principalLabel(principalIndex),
    status,
    expected,
    ok,
    fault: fault.active ? fault.name : null,
    latencyMs: Math.round(latencyMs * 100) / 100,
    requestId: response?.headers.get("x-request-id") || null,
    error: errorMessage,
  });
  if (recentUnexpected.length >= Math.max(10, targetRps * 300 * 0.01)) {
    await hardStop("unexpected error rate exceeded 1% in a five-minute window");
  }
  return { ok, status, body: parsed, response, error: errorMessage, fault };
}

function oracleAdd(principalIndex, record, marker, scope = "actor", threadId = null) {
  const entry = {
    id: record.id,
    principalIndex,
    marker,
    scope,
    threadId,
    state: "active",
    acknowledgedAt: new Date().toISOString(),
  };
  activeOracle.set(entry.id, entry);
  oracleByPrincipal[principalIndex].push(entry.id);
  counters.acknowledgedWrites += 1;
  append(oracleEvents, { event: "acknowledged", ...entry });
  return entry;
}

function oracleRetire(id, state) {
  const entry = activeOracle.get(id);
  if (!entry) return;
  entry.state = state;
  activeOracle.delete(id);
  append(oracleEvents, { event: state, id, at: new Date().toISOString() });
}

async function ingest(principalIndex, { marker, scope = "actor", threadId = null, purpose = "load" } = {}) {
  const principal = principals[principalIndex];
  const next = ++sequence;
  const actualMarker = marker || `soak-${runId}-${principalIndex}-${next}-${Math.floor(random() * 1e9)}`;
  const result = await request({
    op: "ingest",
    principalIndex,
    endpoint: "/v1/memory/ingest",
    purpose,
    body: {
      observations: [{
        ...identity(principal),
        ...(threadId ? { threadId } : {}),
        scope,
        memoryType: "tool_outcome",
        text: `Agent ${principal.appId} retained compatibility marker ${actualMarker}`,
        metadata: { runId, sequence: next, framework: principal.appId },
        source: { sourceType: "framework-compat-soak", sourceId: `${runId}:${next}` },
        confidence: 0.9,
        importance: 0.7,
      }],
    },
  });
  const record = result.body?.records?.[0];
  if (result.ok && record?.id) return oracleAdd(principalIndex, record, actualMarker, scope, threadId);
  if (result.ok) await hardStop("ingest acknowledged without a record id");
  return null;
}

function visibleHit(body, marker) {
  return (body?.hits || []).some((hit) => hit?.memory?.text?.includes(marker));
}

async function searchFor(principalIndex, marker, purpose = "load", mustFind = false) {
  const principal = principals[principalIndex];
  const result = await request({
    op: "search",
    principalIndex,
    endpoint: "/v1/memory/search",
    purpose,
    body: { query: marker, filters: identity(principal), limit: 10 },
  });
  if (result.ok && mustFind && !visibleHit(result.body, marker)) {
    counters.acknowledgedLosses += 1;
    await hardStop(`acknowledged marker was not found during ${purpose}`);
  }
  return result;
}

async function contextFor(principalIndex, marker, purpose = "load", mustFind = false) {
  const principal = principals[principalIndex];
  const result = await request({
    op: "context",
    principalIndex,
    endpoint: "/v1/memory/context",
    purpose,
    body: {
      query: marker,
      filters: identity(principal),
      budget: { maxItems: 10, maxChars: 2000 },
    },
  });
  if (result.ok && mustFind && !String(result.body?.contextText || "").includes(marker)) {
    counters.acknowledgedLosses += 1;
    await hardStop(`acknowledged marker was absent from context during ${purpose}`);
  }
  return result;
}

async function scopedGet(memoryId, principalIndex, purpose, accessThreadId = undefined) {
  const principal = principals[principalIndex];
  return request({
    op: "get",
    principalIndex,
    endpoint: "/v1/memory/get",
    purpose,
    body: { memoryId, ...identity(principal), ...(accessThreadId ? { accessThreadId } : {}) },
  });
}

async function getEntry(entry, purpose = "load") {
  const result = await scopedGet(
    entry.id,
    entry.principalIndex,
    purpose,
    entry.scope === "thread" ? entry.threadId : undefined,
  );
  if (result.ok && entry.state === "active" && result.body?.memory?.id !== entry.id) {
    counters.acknowledgedLosses += 1;
    await hardStop(`acknowledged id ${entry.id} was lost during ${purpose}`);
  }
  return result;
}

async function feedback(entry) {
  const principal = principals[entry.principalIndex];
  return request({
    op: "feedback",
    principalIndex: entry.principalIndex,
    endpoint: "/v1/memory/feedback",
    purpose: "load",
    body: { memoryId: entry.id, signal: "selected", ...identity(principal) },
  });
}

async function archive(entry) {
  const principal = principals[entry.principalIndex];
  const result = await request({
    op: "archive",
    principalIndex: entry.principalIndex,
    endpoint: "/v1/memory/status",
    purpose: "load",
    body: {
      memoryId: entry.id,
      status: "archived",
      metadata: { reason: "soak lifecycle" },
      ...identity(principal),
    },
  });
  if (result.ok && result.body?.updated) oracleRetire(entry.id, "archived");
  return result;
}

async function assertScopedVisibility(memoryId, principalIndex, expectedVisible, purpose, accessThreadId = undefined) {
  if (principalIndex < 0) throw new Error(`no principal available for ${purpose}`);
  const result = await scopedGet(memoryId, principalIndex, purpose, accessThreadId);
  if (!result.ok) {
    await hardStop(`scoped get could not establish ${purpose}`);
    return;
  }
  const visible = result.body?.memory?.id === memoryId;
  if (visible !== expectedVisible) {
    counters.isolationViolations += 1;
    if (expectedVisible) counters.acknowledgedLosses += 1;
    await hardStop(`scoped get visibility mismatch during ${purpose}: expected ${expectedVisible}, got ${visible}`);
  }
}

function randomActive(principalIndex = null) {
  if (principalIndex !== null) {
    const ids = oracleByPrincipal[principalIndex];
    for (let attempts = 0; attempts < 8 && ids.length; attempts += 1) {
      const entry = activeOracle.get(ids[Math.floor(random() * ids.length)]);
      if (entry) return entry;
    }
  }
  const values = [...activeOracle.values()];
  return values.length ? values[Math.floor(random() * values.length)] : null;
}

async function isolationPreflight() {
  const baselines = [];
  for (let index = 0; index < principals.length; index += 1) {
    const marker = `isolation-${runId}-${index}-${Math.floor(random() * 1e12)}`;
    const entry = await ingest(index, { marker, purpose: "isolation-preflight" });
    if (!entry) throw new Error(`failed to create isolation baseline for ${principalLabel(index)}`);
    baselines.push(entry);
  }

  // Actor-scope memory must cross app provenance only for the same tenant,
  // space, and actor.
  for (let sourceIndex = 0; sourceIndex < principals.length; sourceIndex += 1) {
    const source = principals[sourceIndex];
    await assertScopedVisibility(baselines[sourceIndex].id, sourceIndex, true, "actor-owner-positive");
    const peerIndex = principals.findIndex((candidate, index) =>
      index !== sourceIndex
      && candidate.tenantId === source.tenantId
      && candidate.spaceId === source.spaceId
      && candidate.actorId === source.actorId
      && candidate.appId !== source.appId);
    if (peerIndex >= 0) {
      await assertScopedVisibility(baselines[sourceIndex].id, peerIndex, true, "actor-cross-app-positive");
      const peerSearch = await searchFor(peerIndex, baselines[sourceIndex].marker, "cross-app-positive", true);
      if (!peerSearch.ok) await hardStop("cross-app search could not establish actor visibility");
    }

    const foreignIndexes = [
      principals.findIndex((candidate) => candidate.tenantId !== source.tenantId),
      principals.findIndex((candidate) => candidate.tenantId === source.tenantId && candidate.spaceId !== source.spaceId),
      principals.findIndex((candidate) => candidate.tenantId === source.tenantId && candidate.spaceId === source.spaceId && candidate.actorId !== source.actorId),
    ];
    for (const [boundary, foreignIndex] of ["tenant", "space", "actor"].map((boundary, index) => [boundary, foreignIndexes[index]])) {
      await assertScopedVisibility(baselines[sourceIndex].id, foreignIndex, false, `actor-${boundary}-negative`);
    }
    const foreignIndex = foreignIndexes[0];
    const foreignResult = await searchFor(foreignIndex, baselines[sourceIndex].marker, "isolation-search-negative", false);
    if (!foreignResult.ok) await hardStop("foreign search could not establish isolation");
    if (visibleHit(foreignResult.body, baselines[sourceIndex].marker)) {
      counters.isolationViolations += 1;
      await hardStop(`cross-principal marker leaked from ${principalLabel(sourceIndex)} to ${principalLabel(foreignIndex)}`);
    }
  }

  const owner = principals[0];
  for (const [label, forged] of [
    ["tenant", { ...identity(owner), tenantId: `${owner.tenantId}-forged` }],
    ["space", { ...identity(owner), spaceId: `${owner.spaceId}-forged` }],
    ["actor", { ...identity(owner), actorId: `${owner.actorId}-forged` }],
    ["app", { ...identity(owner), appId: `${owner.appId}-forged` }],
  ]) {
    const boundary = await request({
      op: "auth-boundary",
      principalIndex: 0,
      endpoint: "/v1/memory/search",
      purpose: `forged-${label}`,
      expected: [403],
      body: { query: "forged", filters: forged, limit: 1 },
    });
    if (!boundary.ok) await hardStop(`forged ${label} identity was not rejected`);
  }

  const invalid = await request({
    op: "auth-boundary",
    principalIndex: null,
    apiKeyOverride: "invalid-framework-soak-key",
    endpoint: "/v1/memory/search",
    purpose: "invalid-key",
    expected: [401],
    body: { query: "invalid", filters: identity(owner) },
  });
  if (!invalid.ok) await hardStop("invalid API key was not rejected with 401");

  const tenantWrite = await request({
    op: "auth-boundary",
    principalIndex: 0,
    endpoint: "/v1/memory/ingest",
    purpose: "principal-tenant-write-denied",
    expected: [403],
    body: {
      observations: [{
        ...identity(owner),
        scope: "tenant",
        memoryType: "fact",
        text: `Forbidden tenant memory ${runId}`,
        source: { sourceType: "framework-compat-soak" },
      }],
    },
  });
  if (!tenantWrite.ok) await hardStop("principal credential was allowed to request a tenant write");

  const mixedMarker = `mixed-atomicity-${runId}-${Math.floor(random() * 1e12)}`;
  const mixed = await request({
    op: "auth-boundary",
    principalIndex: 0,
    endpoint: "/v1/memory/ingest",
    purpose: "mixed-batch-atomicity",
    expected: [403],
    body: {
      observations: [
        {
          ...identity(owner),
          memoryType: "fact",
          text: `Legitimate half ${mixedMarker}`,
          source: { sourceType: "framework-compat-soak" },
        },
        {
          ...identity(owner),
          actorId: `${owner.actorId}-forged`,
          memoryType: "fact",
          text: `Forged half ${mixedMarker}`,
          source: { sourceType: "framework-compat-soak" },
        },
      ],
    },
  });
  if (!mixed.ok) await hardStop("mixed authorized/forged batch did not fail atomically");
  const afterMixed = await searchFor(0, mixedMarker, "mixed-batch-audit", false);
  if (afterMixed.ok && visibleHit(afterMixed.body, mixedMarker)) {
    await hardStop("mixed authorized/forged batch partially committed");
  }

  await scopeMatrixPreflight();
}

async function scopeMatrixPreflight() {
  const sourceIndex = 0;
  const source = principals[sourceIndex];
  const sameActorOtherApp = principals.findIndex((candidate, index) =>
    index !== sourceIndex
    && candidate.tenantId === source.tenantId
    && candidate.spaceId === source.spaceId
    && candidate.actorId === source.actorId
    && candidate.appId !== source.appId);
  const sameSpaceSameAppOtherActor = principals.findIndex((candidate) =>
    candidate.tenantId === source.tenantId
    && candidate.spaceId === source.spaceId
    && candidate.actorId !== source.actorId
    && candidate.appId === source.appId);
  const sameSpaceOtherApp = principals.findIndex((candidate) =>
    candidate.tenantId === source.tenantId
    && candidate.spaceId === source.spaceId
    && candidate.appId !== source.appId);
  const otherSpaceSameApp = principals.findIndex((candidate) =>
    candidate.tenantId === source.tenantId
    && candidate.spaceId !== source.spaceId
    && candidate.appId === source.appId);

  const appEntry = await ingest(sourceIndex, {
    marker: `scope-app-${runId}-${Math.floor(random() * 1e12)}`,
    scope: "app",
    purpose: "scope-matrix",
  });
  if (!appEntry) throw new Error("failed to create app-scope baseline");
  await assertScopedVisibility(appEntry.id, sameSpaceSameAppOtherActor, true, "app-same-space-positive");
  await assertScopedVisibility(appEntry.id, sameSpaceOtherApp, false, "app-cross-app-negative");
  await assertScopedVisibility(appEntry.id, otherSpaceSameApp, false, "app-cross-space-negative");

  const workspaceEntry = await ingest(sourceIndex, {
    marker: `scope-workspace-${runId}-${Math.floor(random() * 1e12)}`,
    scope: "workspace",
    purpose: "scope-matrix",
  });
  if (!workspaceEntry) throw new Error("failed to create workspace-scope baseline");
  await assertScopedVisibility(workspaceEntry.id, sameSpaceOtherApp, true, "workspace-same-space-positive");
  await assertScopedVisibility(workspaceEntry.id, otherSpaceSameApp, false, "workspace-cross-space-negative");

  const threadId = `thread-${runId}-scope-matrix`;
  const threadEntry = await ingest(sourceIndex, {
    marker: `scope-thread-${runId}-${Math.floor(random() * 1e12)}`,
    scope: "thread",
    threadId,
    purpose: "scope-matrix",
  });
  if (!threadEntry) throw new Error("failed to create thread-scope baseline");
  await assertScopedVisibility(threadEntry.id, sourceIndex, true, "thread-owner-positive", threadId);
  await assertScopedVisibility(threadEntry.id, sameActorOtherApp, true, "thread-cross-app-positive", threadId);
  await assertScopedVisibility(threadEntry.id, sameActorOtherApp, false, "thread-wrong-thread-negative", `${threadId}-wrong`);
  await assertScopedVisibility(threadEntry.id, sameActorOtherApp, false, "thread-missing-thread-negative");
  await assertScopedVisibility(threadEntry.id, sameSpaceSameAppOtherActor, false, "thread-cross-actor-negative", threadId);
}

async function concurrencyPreflight() {
  const principalIndex = 0;
  const principal = principals[principalIndex];
  const marker = `concurrent-dedupe-${runId}-${Math.floor(random() * 1e12)}`;
  const observation = {
    ...identity(principal),
    scope: "actor",
    memoryType: "fact",
    text: `Concurrent exact dedupe marker ${marker}`,
    metadata: { runId, probe: "concurrent-dedupe" },
    source: { sourceType: "framework-compat-soak", sourceId: `${runId}:concurrent-dedupe` },
    confidence: 0.9,
    importance: 0.7,
  };
  const duplicateResults = await Promise.all(Array.from({ length: 20 }, () => request({
    op: "concurrency-dedupe",
    principalIndex,
    endpoint: "/v1/memory/ingest",
    purpose: "concurrency-preflight",
    body: { observations: [observation] },
  })));
  const records = duplicateResults.flatMap((result) => result.body?.records || []);
  const uniqueRecords = [...new Map(records.filter((record) => record?.id).map((record) => [record.id, record])).values()];
  const activeIds = [];
  for (const record of uniqueRecords) {
    const found = await scopedGet(record.id, principalIndex, "concurrency-dedupe-audit");
    if (found.ok && found.body?.memory?.id === record.id) {
      activeIds.push(record.id);
      oracleAdd(principalIndex, record, marker);
    }
  }
  const dedupePassed = duplicateResults.every((result) => result.ok)
    && records.length === duplicateResults.length
    && activeIds.length === 1;
  concurrencyResults.exactDedupe = {
    passed: dedupePassed,
    attempts: duplicateResults.length,
    acknowledgedResponses: records.length,
    uniqueReturnedIds: uniqueRecords.length,
    activeUniqueIds: activeIds.length,
  };
  if (!dedupePassed) counters.concurrencyFailures += 1;

  const feedbackEntry = await ingest(principalIndex, {
    marker: `concurrent-feedback-${runId}-${Math.floor(random() * 1e12)}`,
    purpose: "concurrency-preflight",
  });
  if (!feedbackEntry) throw new Error("failed to create concurrent feedback baseline");
  const before = await scopedGet(feedbackEntry.id, principalIndex, "concurrent-feedback-before");
  const beforeCount = before.body?.memory?.stats?.positiveCount;
  const feedbackResults = await Promise.all(Array.from({ length: 20 }, () => request({
    op: "concurrency-feedback",
    principalIndex,
    endpoint: "/v1/memory/feedback",
    purpose: "concurrency-preflight",
    body: { memoryId: feedbackEntry.id, signal: "positive", ...identity(principal) },
  })));
  const after = await scopedGet(feedbackEntry.id, principalIndex, "concurrent-feedback-after");
  const afterCount = after.body?.memory?.stats?.positiveCount;
  const feedbackPassed = before.ok
    && after.ok
    && feedbackResults.every((result) => result.ok && result.body?.updated === true)
    && Number.isInteger(beforeCount)
    && afterCount - beforeCount === feedbackResults.length;
  concurrencyResults.atomicFeedback = {
    passed: feedbackPassed,
    attempts: feedbackResults.length,
    beforePositiveCount: beforeCount ?? null,
    afterPositiveCount: afterCount ?? null,
  };
  if (!feedbackPassed) counters.concurrencyFailures += 1;

  append(oracleEvents, {
    event: "concurrency-preflight",
    at: new Date().toISOString(),
    results: concurrencyResults,
  });
}

async function verifyAuditEntry(entry, purpose) {
  let lastResult;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = await scopedGet(
      entry.id,
      entry.principalIndex,
      purpose,
      entry.scope === "thread" ? entry.threadId : undefined,
    );
    if (lastResult.ok && lastResult.body?.memory?.id === entry.id) return "FOUND";
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  if (lastResult?.ok) {
    counters.acknowledgedLosses += 1;
    append(oracleEvents, {
      event: "audit-lost",
      at: new Date().toISOString(),
      purpose,
      id: entry.id,
      principal: principalLabel(entry.principalIndex),
    });
    await hardStop(`acknowledged id ${entry.id} was lost during ${purpose}`);
    return "LOST";
  }
  counters.auditUnverified += 1;
  append(oracleEvents, {
    event: "audit-unverified",
    at: new Date().toISOString(),
    purpose,
    id: entry.id,
    principal: principalLabel(entry.principalIndex),
    status: lastResult?.status ?? 0,
    error: lastResult?.error,
  });
  await hardStop(`acknowledged id ${entry.id} could not be verified during ${purpose}`);
  return "UNVERIFIED";
}

async function waitForWorkloadDrain(purpose) {
  const drainDeadline = performance.now() + requestTimeoutMs + 2_000;
  while (inFlight > 0 && performance.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (inFlight > 0) {
    const reason = `${purpose} audit barrier timed out waiting for ${inFlight} workload operation(s)`;
    await hardStop(reason);
    throw new Error(reason);
  }
}

async function auditAll({ purpose, requestId, requestedAt }) {
  counters.audits += 1;
  const startedAt = new Date().toISOString();
  await waitForWorkloadDrain(purpose);
  const snapshotAt = new Date().toISOString();
  const snapshot = [...activeOracle.values()];
  let cursor = 0;
  const results = { FOUND: 0, LOST: 0, UNVERIFIED: 0 };
  const workers = Array.from({ length: Math.min(10, snapshot.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= snapshot.length) return;
      const result = await verifyAuditEntry(snapshot[index], purpose);
      results[result] += 1;
      if (result === "FOUND") counters.auditRecords += 1;
    }
  });
  await Promise.all(workers);
  counters.auditsCompleted += 1;
  const completedAt = new Date().toISOString();
  const accountedRecords = results.FOUND + results.LOST + results.UNVERIFIED;
  const successful = results.LOST === 0
    && results.UNVERIFIED === 0
    && results.FOUND === snapshot.length
    && accountedRecords === snapshot.length;
  const completed = {
    requestId: requestId || null,
    purpose,
    requestedAt,
    startedAt,
    snapshotAt,
    completedAt,
    records: snapshot.length,
    accountedRecords,
    results,
    successful,
  };
  append(oracleEvents, {
    event: "audit-complete",
    at: completedAt,
    ...completed,
    losses: counters.acknowledgedLosses,
  });
  return completed;
}

function queueAudit(purpose, requestId = "") {
  const request = {
    requestId: requestId || null,
    purpose,
    requestedAt: new Date().toISOString(),
  };
  lastRequestedAudit = request;
  queuedAudits += 1;
  auditBarrierDepth += 1;
  const completion = auditChain.catch(() => {}).then(async () => {
    queuedAudits -= 1;
    activeAudit = {
      ...request,
      startedAt: new Date().toISOString(),
    };
    try {
      const completed = await auditAll(request);
      lastCompletedAudit = completed;
      if (requestId) lastCompletedAuditRequest = requestId;
      return completed;
    } finally {
      activeAudit = null;
      auditBarrierDepth -= 1;
    }
  });
  auditChain = completion;
  return completion;
}

async function periodicIsolationProbe() {
  if (activeOracle.size < 2 || stopping) return;
  const source = randomActive();
  if (!source) return;
  const sourcePrincipal = principals[source.principalIndex];
  const foreignIndex = principals.findIndex((candidate) => {
    if (candidate.tenantId !== sourcePrincipal.tenantId) return true;
    if (source.scope !== "tenant" && candidate.spaceId !== sourcePrincipal.spaceId) return true;
    if (source.scope === "app" && candidate.appId !== sourcePrincipal.appId) return true;
    if ((source.scope === "actor" || source.scope === "thread") && candidate.actorId !== sourcePrincipal.actorId) return true;
    return false;
  });
  await assertScopedVisibility(
    source.id,
    foreignIndex,
    false,
    "periodic-isolation",
    source.scope === "thread" ? source.threadId : undefined,
  );
}

async function workloadOperation() {
  const principalIndex = Math.floor(random() * principals.length);
  const roll = random();
  if (roll < 0.20) {
    await ingest(principalIndex);
    return;
  }
  const entry = randomActive(principalIndex) || randomActive();
  if (!entry) {
    await ingest(principalIndex);
    return;
  }
  if (roll < 0.50) await searchFor(entry.principalIndex, entry.marker, "load", true);
  else if (roll < 0.75) await contextFor(entry.principalIndex, entry.marker, "load", true);
  else if (roll < 0.85) await getEntry(entry);
  else if (roll < 0.95) await feedback(entry);
  else await archive(entry);
}

async function writeHeartbeat() {
  const timing = observeClock();
  const workload = workloadSnapshot(timing);
  const disk = await statfs(runDir);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  const totalBytes = Number(disk.blocks) * Number(disk.bsize);
  if (freeBytes < 10 * 1024 ** 3 || freeBytes / totalBytes < 0.15) {
    await hardStop("host disk safety threshold reached");
  }
  const fault = await faultState();
  if (fault.auditRequested && fault.auditRequested !== lastAuditRequest && !fault.active) {
    lastAuditRequest = fault.auditRequested;
    await queueAudit(`post-fault:${fault.lastCompleted || "unknown"}`, fault.auditRequested);
  }
  await atomicJson("heartbeat.json", {
    schemaVersion: 1,
    runId,
    pid: process.pid,
    phase,
    startedAt: new Date(processStartedAtMs).toISOString(),
    workloadStartedAt: workloadStartedAtMs === null ? null : new Date(workloadStartedAtMs).toISOString(),
    updatedAt: new Date().toISOString(),
    deadlineAt: deadlineAtMs === null ? null : new Date(deadlineAtMs).toISOString(),
    elapsedSeconds: timing.elapsedSeconds,
    fullConfiguredDuration: timing.fullConfiguredDuration,
    timing,
    workload,
    inFlight,
    activeOracleRecords: activeOracle.size,
    counters,
    statusCounts,
    fault,
    lastCompletedAuditRequest,
    lastCompletedAudit,
    audit: {
      queued: queuedAudits,
      barrierDepth: auditBarrierDepth,
      workloadPaused: auditBarrierDepth > 0,
      inProgress: activeAudit,
      lastRequested: lastRequestedAudit,
      lastCompleted: lastCompletedAudit,
    },
    hardStopReason,
    disk: { freeBytes, totalBytes },
  });
}

function queueHeartbeat() {
  const completion = heartbeatChain.catch(() => {}).then(() => writeHeartbeat());
  heartbeatChain = completion;
  return completion;
}

async function hardStop(reason) {
  if (hardStopReason) return;
  hardStopReason = reason;
  markStopping();
  append(events, { at: new Date().toISOString(), op: "hard-stop", reason });
  if (scheduler) clearInterval(scheduler);
}

async function finalize() {
  markStopping();
  if (scheduler) clearInterval(scheduler);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (auditTimer) clearInterval(auditTimer);
  await waitForWorkloadDrain("finalization").catch(() => {});
  await heartbeatChain.catch(async (error) => {
    await hardStop(`heartbeat failed during finalization: ${error instanceof Error ? error.message : String(error)}`);
  });
  await auditChain.catch(() => {});
  await queueAudit("final");
  await queueHeartbeat().catch(async (error) => {
    await hardStop(`final heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await heartbeatChain.catch(() => {});
  const timing = observeClock();
  const workload = workloadSnapshot(timing);
  const workloadTargetRpsAchieved = workload.targetRpsAchievementRatio >= minimumTargetRpsRatio;
  const schedulerDropRatioWithinLimit = workload.schedulerDropRatio <= maximumSchedulerDropRatio;
  const workloadSchedulingAccounted = workload.schedulingAccountingBalanced;
  const qualificationFailureReasons = [
    ...(timing.fullConfiguredDuration ? [] : ["configured workload duration was not completed"]),
    ...(workloadTargetRpsAchieved ? [] : [
      `achieved RPS ${workload.achievedRps} was below ${minimumTargetRpsRatio * 100}% of target ${targetRps}`,
    ]),
    ...(schedulerDropRatioWithinLimit ? [] : [
      `scheduler drop ratio ${workload.schedulerDropRatio} exceeded ${maximumSchedulerDropRatio}`,
    ]),
    ...(workloadSchedulingAccounted ? [] : ["workload scheduling counters did not balance"]),
  ];
  const finishedAt = new Date().toISOString();
  const summary = {
    schemaVersion: 1,
    runId,
    result: hardStopReason || qualificationFailureReasons.length > 0
      ? "FAILED"
      : counters.unexpected > 0 || counters.concurrencyFailures > 0 ? "ADVISORY" : "PASSED",
    hardStopReason,
    qualificationFailureReasons,
    startedAt: new Date(processStartedAtMs).toISOString(),
    workloadStartedAt: workloadStartedAtMs === null ? null : new Date(workloadStartedAtMs).toISOString(),
    finishedAt,
    deadlineAt: deadlineAtMs === null ? null : new Date(deadlineAtMs).toISOString(),
    elapsedSeconds: timing.elapsedSeconds,
    configuredDurationSeconds: durationSeconds,
    timing,
    workload,
    targetRps,
    maxConcurrency,
    principalCount: principals.length,
    counters,
    statusCounts,
    operations: statsSnapshot(),
    concurrency: concurrencyResults,
    audits: {
      lastRequested: lastRequestedAudit,
      lastCompleted: lastCompletedAudit,
    },
    gates: {
      zeroIsolationViolations: counters.isolationViolations === 0,
      zeroAcknowledgedLosses: counters.acknowledgedLosses === 0,
      zeroUnverifiedAuditRecords: counters.auditUnverified === 0,
      concurrencyPreflightPassed: counters.concurrencyFailures === 0,
      noHardStop: hardStopReason === null,
      noWallClockJump: !timing.wallClockJumpDetected,
      fullConfiguredDuration: timing.fullConfiguredDuration,
      workloadTargetRpsAchieved,
      schedulerDropRatioWithinLimit,
      workloadSchedulingAccounted,
    },
    claimLimits: [
      "This run covers the exact pinned build, host, configuration, and elapsed interval only.",
      "Protocol-host probes do not establish autonomous LLM tool-selection quality.",
      "A single-node Postgres run does not establish multi-replica high availability or fleet-wide quotas.",
      "Remote supersede and multi-observation ingest atomicity are not established by this run.",
    ],
  };
  await atomicJson("summary.json", summary);
  await new Promise((resolve) => events.end(resolve));
  await new Promise((resolve) => oracleEvents.end(resolve));
  return summary;
}

// Seeded xorshift32 makes request selection reproducible without making memory
// canaries predictable credentials (canaries are not credentials).
let randomState = createHash("sha256").update(runId).digest().readUInt32LE(0) || 0x9e3779b9;
function random() {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0x1_0000_0000;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    append(events, { at: new Date().toISOString(), op: "signal", signal });
    void hardStop(`received ${signal} before the configured duration completed`);
  });
}

let finalSummary;
try {
  await queueHeartbeat();
  if (hardStopReason) throw new Error(hardStopReason);
  heartbeatTimer = setInterval(() => {
    void queueHeartbeat().catch((error) => hardStop(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`));
  }, 10_000);

  // Readiness must be green before any compatibility claim is attempted.
  const readyDeadline = performance.now() + 300_000;
  let ready = false;
  while (!stopping && performance.now() < readyDeadline) {
    const result = await request({
      op: "ready",
      principalIndex: null,
      method: "GET",
      endpoint: "/ready",
      expected: [200],
      purpose: "startup",
    });
    if (result.ok) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("service did not become ready within five minutes");

  await isolationPreflight();
  if (hardStopReason) throw new Error(hardStopReason);
  await concurrencyPreflight();
  if (hardStopReason) throw new Error(hardStopReason);

  workloadStartedAtPerformance = performance.now();
  workloadStartedAtMs = Date.now();
  deadlinePerformance = workloadStartedAtPerformance + durationMs;
  deadlineAtMs = workloadStartedAtMs + durationMs;
  phase = "WORKLOAD_RUNNING";

  const intervalMs = 1000 / targetRps;
  scheduler = setInterval(() => {
    observeClock();
    if (stopping || performance.now() >= deadlinePerformance) {
      markStopping();
      clearInterval(scheduler);
      return;
    }
    workloadMetrics.scheduled += 1;
    if (auditBarrierDepth > 0) {
      workloadMetrics.auditPaused += 1;
      return;
    }
    if (inFlight >= maxConcurrency) {
      counters.schedulerDrops += 1;
      workloadMetrics.schedulerDrops += 1;
      return;
    }
    workloadMetrics.started += 1;
    inFlight += 1;
    void workloadOperation()
      .catch(async (error) => hardStop(`workload exception: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        workloadMetrics.completed += 1;
        inFlight -= 1;
      });
  }, intervalMs);
  auditTimer = setInterval(() => void periodicIsolationProbe().catch((error) => hardStop(`isolation probe failed: ${error}`)), 60_000);
  await queueHeartbeat();

  while (!stopping && performance.now() < deadlinePerformance) {
    observeClock();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  markStopping();
} catch (error) {
  await hardStop(error instanceof Error ? error.message : String(error));
} finally {
  finalSummary = await finalize();
}

process.stdout.write(`${JSON.stringify(finalSummary)}\n`);
process.exitCode = finalSummary.result === "FAILED" ? 2 : 0;
