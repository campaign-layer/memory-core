#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

process.umask(0o077);

const root = path.resolve(required("MEMORY_CORE_ROOT"));
const runDir = path.resolve(required("MC_RUN_DIR"));
const runId = required("MC_RUN_ID");
const durationSeconds = integerEnv("MC_DURATION_SECONDS", 60, 604_800, 86_400);
const reprobeSeconds = integerEnv("MC_REPROBE_SECONDS", 60, 86_400, 21_600);
const port = integerEnv("MC_PORT", 1, 65_535);
const targetRps = integerEnv("MC_RPS", 1, 100, 2);
const maxConcurrency = integerEnv("MC_CONCURRENCY", 1, 64);
const baseUrl = required("MC_BASE_URL").replace(/\/$/, "");
const postgresImage = required("POSTGRES_IMAGE");
const faultSchedule = JSON.parse(process.env.MC_FAULT_SCHEDULE_JSON || "[]");
const allowedFaults = new Set(["app-graceful-restart", "app-sigkill", "db-graceful-restart", "db-sigkill"]);
const canonicalRequiredProbes = [
  "generic-mcp", "langchain", "langgraph", "openai-agents", "openai-agents-adapter",
  "autogen", "crewai", "claude-code", "codex-cli", "hermes", "openclaw",
];
const expectedVersionEnvironmentNames = [
  "MC_EXPECTED_MCP_SDK_VERSION",
  "MC_EXPECTED_LANGCHAIN_MCP_VERSION",
  "MC_EXPECTED_LANGGRAPH_VERSION",
  "MC_EXPECTED_OPENAI_AGENTS_VERSION",
  "AUTOGEN_EXPECTED_VERSION",
  "CREWAI_EXPECTED_VERSION",
  "CLAUDE_EXPECTED_VERSION",
  "CODEX_EXPECTED_VERSION",
  "OPENCLAW_EXPECTED_VERSION",
  "HERMES_EXPECTED_VERSION",
];
const runtimeContractKeys = [
  "baseUrl", "composeProjectName", "concurrency", "durationSeconds", "expectedVersions",
  "gitSha", "gitTree", "port", "postgresImage", "reprobeSeconds", "requiredProbes", "rps",
];
const resourceIntervalMs = 30_000;
const generationIntervalMs = 10_000;
const maximumResourceSuccessGapMs = 90_000;
const workloadStartupTimeoutMs = 20 * 60_000;
const profileContracts = {
  none: {
    result: "SMOKE_PASSED",
    minimumDurationSeconds: 60,
    schedule: [],
  },
  canary: {
    result: "CANARY_PASSED",
    minimumDurationSeconds: 600,
    schedule: [
      { atSeconds: 60, name: "app-graceful-restart" },
      { atSeconds: 150, name: "app-sigkill" },
      { atSeconds: 300, name: "db-graceful-restart" },
      { atSeconds: 450, name: "db-sigkill" },
    ],
  },
  primary: {
    result: "PASSED",
    minimumDurationSeconds: 86_400,
    schedule: [
      { atSeconds: 7_200, name: "app-graceful-restart" },
      { atSeconds: 21_600, name: "app-sigkill" },
      { atSeconds: 43_200, name: "db-graceful-restart" },
      { atSeconds: 64_800, name: "db-sigkill" },
    ],
  },
};
if (!Array.isArray(faultSchedule) || faultSchedule.some((fault) =>
  !allowedFaults.has(fault?.name)
  || !Number.isInteger(fault?.atSeconds)
  || fault.atSeconds <= 0
  || fault.atSeconds >= durationSeconds)) {
  throw new Error("MC_FAULT_SCHEDULE_JSON contains an invalid or out-of-window fault");
}
if (new Set(faultSchedule.map((fault) => fault.name)).size !== faultSchedule.length) {
  throw new Error("MC_FAULT_SCHEDULE_JSON contains duplicate fault names");
}

const expectedComposeProjectName = `mc-compat-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
const declaredComposeProjectName = process.env.COMPOSE_PROJECT_NAME || null;
const expectedPeriodicProbeSlots = Array.from(
  { length: Math.floor((durationSeconds - 1) / reprobeSeconds) },
  (_unused, index) => ({ slot: index + 1, atSeconds: (index + 1) * reprobeSeconds }),
);
const activeChildren = new Set();
const bootstrapManifest = await readJson("manifest.bootstrap.json");
const runtimeContract = runtimeContractValidation(bootstrapManifest);
const profile = profileConfiguration(bootstrapManifest);
const startedAt = new Date().toISOString();
const sourceAtStart = await inspectSourceProvenance();
await writeFile(path.join(runDir, "campaign.started.json"), `${JSON.stringify({
  schemaVersion: 1,
  runId,
  pid: process.pid,
  startedAt,
  durationSeconds,
  faultSchedule,
  profile,
  runtimeContract,
  expectedPeriodicProbeSlots,
  compose: {
    declaredProjectName: declaredComposeProjectName,
    expectedProjectName: expectedComposeProjectName,
    verified: profile.composeProjectNameVerified,
  },
  source: sourceAtStart,
})}\n`, { mode: 0o600, flag: "wx" });

const envFile = path.join(runDir, "run.env");
const composeFile = path.join(root, "bench", "framework-compat", "compose.yml");
const composeBase = [
  "compose",
  "--project-name", expectedComposeProjectName,
  "--env-file", envFile,
  "-f", composeFile,
];
const campaignEvents = createWriteStream(path.join(runDir, "campaign.ndjson"), { flags: "a", mode: 0o600 });
const resourceEvents = createWriteStream(path.join(runDir, "resources.ndjson"), { flags: "a", mode: 0o600 });
const timers = [];
const frameworkRuns = [];
const faults = [];
let soak = null;
let soakExitObserved = null;
let soakExitPromise = null;
let soakLogCompletion = Promise.resolve();
let ending = false;
let signalReceived = null;
let controllerHardStopReason = null;
let resourceCollection = Promise.resolve();
let maintenanceChain = Promise.resolve();
let generationMonitorChain = Promise.resolve();
let workloadAnchor = null;
let plannedFault = null;
let expectedGenerations = null;
let containerImageAtStart = null;
let containerImageAtFinish = null;
const generationMonitoring = {
  checks: 0,
  successfulServiceChecks: 0,
  failedServiceChecks: 0,
  baselineUpdates: [],
  violations: [],
  lastVerifiedAtMs: { "memory-core": null, db: null },
};
const resourceStats = {
  attempted: 0,
  successful: 0,
  failed: 0,
  successfulAtMs: [],
};

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

function integerEnv(name, min, max, fallback = null) {
  const raw = process.env[name] || fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((name, index) => name === canonical[index]);
}

function exactStringSet(value, expected) {
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== "string")
    || new Set(value).size !== value.length
    || value.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return value.every((item) => expectedSet.has(item));
}

function runtimeContractValidation(manifest) {
  const contract = manifest?.runtimeContract;
  let environmentContract = null;
  try {
    environmentContract = JSON.parse(process.env.MC_RUNTIME_CONTRACT_JSON || "null");
  } catch { /* recorded as a failed exact runtime-contract gate */ }
  const declaredRequiredProbes = (process.env.MC_REQUIRED_PROBES || "")
    .split(",").map((name) => name.trim()).filter(Boolean);
  const runtimeExpectedVersions = Object.fromEntries(
    expectedVersionEnvironmentNames.map((name) => [name, process.env[name] || null]),
  );
  const gates = {
    exactShape: exactObjectKeys(contract, runtimeContractKeys),
    runtimeEnvironmentContractMatchesBootstrap: JSON.stringify(environmentContract) === JSON.stringify(contract),
    exactExpectedVersionKeys: exactObjectKeys(contract?.expectedVersions, expectedVersionEnvironmentNames),
    canonicalBootstrapRequiredProbes: exactStringSet(contract?.requiredProbes, canonicalRequiredProbes)
      && exactStringSet(manifest?.requiredProbes, canonicalRequiredProbes),
    canonicalRuntimeRequiredProbes: exactStringSet(declaredRequiredProbes, canonicalRequiredProbes),
    expectedVersionsMatchRuntime: expectedVersionEnvironmentNames.every((name) =>
      typeof runtimeExpectedVersions[name] === "string"
      && runtimeExpectedVersions[name].length > 0
      && contract?.expectedVersions?.[name] === runtimeExpectedVersions[name]),
    gitShaMatches: contract?.gitSha === process.env.MC_GIT_SHA
      && manifest?.gitSha === process.env.MC_GIT_SHA,
    gitTreeMatches: contract?.gitTree === process.env.MC_GIT_TREE
      && manifest?.gitTree === process.env.MC_GIT_TREE,
    composeProjectMatches: contract?.composeProjectName === expectedComposeProjectName
      && manifest?.composeProjectName === expectedComposeProjectName
      && declaredComposeProjectName === expectedComposeProjectName,
    baseUrlMatches: contract?.baseUrl === process.env.MC_BASE_URL
      && contract?.baseUrl === baseUrl
      && baseUrl === `http://127.0.0.1:${port}`,
    portMatches: contract?.port === port && manifest?.port === port,
    durationMatches: contract?.durationSeconds === durationSeconds
      && manifest?.durationSeconds === durationSeconds,
    rpsMatches: contract?.rps === targetRps && manifest?.rps === targetRps,
    concurrencyMatches: contract?.concurrency === maxConcurrency
      && manifest?.concurrency === maxConcurrency,
    postgresImageMatches: contract?.postgresImage === postgresImage
      && manifest?.postgresImage === postgresImage,
    reprobeMatches: contract?.reprobeSeconds === reprobeSeconds,
  };
  return {
    valid: Object.values(gates).every(Boolean),
    gates,
    canonicalRequiredProbes,
    declaredRequiredProbes,
    expectedVersionEnvironmentNames,
    runtimeExpectedVersions,
    environmentContractPresent: environmentContract !== null,
  };
}

function sameFaultSchedule(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((fault, index) => fault?.name === right[index]?.name
      && fault?.atSeconds === right[index]?.atSeconds);
}

function profileConfiguration(manifest) {
  const manifestProfile = typeof manifest?.faultProfile === "string" ? manifest.faultProfile : null;
  const declaredProfile = process.env.MC_FAULT_PROFILE || null;
  const contract = manifestProfile && Object.hasOwn(profileContracts, manifestProfile)
    ? profileContracts[manifestProfile]
    : null;
  const manifestScheduleMatchesRuntime = sameFaultSchedule(manifest?.faultSchedule, faultSchedule);
  const scheduleMatchesProfile = !!contract && sameFaultSchedule(faultSchedule, contract.schedule);
  const configuredFaultCountMatchesProfile = !!contract && faultSchedule.length === contract.schedule.length;
  const durationMinimumMet = !!contract && durationSeconds >= contract.minimumDurationSeconds;
  const bootstrapMatchesRuntime = manifest?.runId === runId
    && manifest?.durationSeconds === durationSeconds
    && manifestScheduleMatchesRuntime;
  const profileDeclarationsMatch = !!contract && declaredProfile === manifestProfile;
  const composeProjectNameVerified = declaredComposeProjectName === expectedComposeProjectName
    && manifest?.composeProjectName === expectedComposeProjectName;
  return {
    name: manifestProfile,
    declaredName: declaredProfile,
    recognized: !!contract,
    expectedResult: contract?.result || null,
    minimumDurationSeconds: contract?.minimumDurationSeconds ?? null,
    expectedFaultCount: contract?.schedule.length ?? null,
    configuredFaultCount: faultSchedule.length,
    bootstrapMatchesRuntime,
    profileDeclarationsMatch,
    manifestScheduleMatchesRuntime,
    scheduleMatchesProfile,
    configuredFaultCountMatchesProfile,
    durationMinimumMet,
    composeProjectNameVerified,
    valid: !!contract
      && bootstrapMatchesRuntime
      && profileDeclarationsMatch
      && scheduleMatchesProfile
      && configuredFaultCountMatchesProfile
      && durationMinimumMet
      && composeProjectNameVerified,
  };
}

function event(type, fields = {}) {
  const record = { at: new Date().toISOString(), type, ...fields };
  if (!campaignEvents.writableEnded && !campaignEvents.destroyed) {
    campaignEvents.write(`${JSON.stringify(record)}\n`);
  }
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    const limit = options.limit || 10_000_000;
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-limit); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-limit); });
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, options.timeoutMs || 300_000);
    child.on("error", (error) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish({ code: null, error: error.message, stdout, stderr, timedOut });
    });
    child.on("close", (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function inspectSourceProvenance() {
  const gitEnv = { ...process.env };
  for (const name of Object.keys(gitEnv)) {
    if (name.startsWith("GIT_")) delete gitEnv[name];
  }
  const [headResult, treeResult, statusResult, topLevelResult] = await Promise.all([
    run("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { env: gitEnv, limit: 1_000_000 }),
    run("git", ["-C", root, "rev-parse", "--verify", "HEAD^{tree}"], { env: gitEnv, limit: 1_000_000 }),
    run("git", [
      "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none",
    ], { env: gitEnv, limit: 50_000_000 }),
    run("git", ["-C", root, "rev-parse", "--show-toplevel"], { env: gitEnv, limit: 1_000_000 }),
  ]);
  const head = commandPassed(headResult) ? headResult.stdout.trim() : null;
  const tree = commandPassed(treeResult) ? treeResult.stdout.trim() : null;
  const topLevel = commandPassed(topLevelResult) ? topLevelResult.stdout.trim() : null;
  let topLevelMatchesRoot = false;
  try {
    topLevelMatchesRoot = !!topLevel && await realpath(topLevel) === await realpath(root);
  } catch { /* invalid repository path is recorded as a failed provenance check */ }
  const statusOutput = statusResult.stdout || "";
  const clean = commandPassed(statusResult) && statusOutput.length === 0;
  return {
    checkedAt: new Date().toISOString(),
    ok: commandPassed(headResult)
      && commandPassed(treeResult)
      && commandPassed(statusResult)
      && commandPassed(topLevelResult)
      && /^[0-9a-f]{40,64}$/.test(head || "")
      && /^[0-9a-f]{40,64}$/.test(tree || "")
      && topLevelMatchesRoot,
    head,
    tree,
    clean,
    topLevelMatchesRoot,
    dirtyEntryCount: statusOutput ? statusOutput.split("\0").filter(Boolean).length : 0,
    statusSha256: createHash("sha256").update(statusOutput).digest("hex"),
    commands: {
      head: commandEvidence(headResult),
      tree: commandEvidence(treeResult),
      status: commandEvidence(statusResult),
      topLevel: commandEvidence(topLevelResult),
    },
  };
}

function compose(...args) {
  return run("docker", [...composeBase, ...args]);
}

async function inspectContainerImageProvenance() {
  const ps = await compose("ps", "-q", "memory-core");
  if (!commandPassed(ps) || !ps.stdout.trim()) {
    return { passed: false, reason: "memory-core container is not running", commands: { ps: commandEvidence(ps) } };
  }
  const containerId = ps.stdout.trim().split("\n")[0];
  const container = await run("docker", [
    "inspect", "--format",
    "{{.Image}}\t{{index .Config.Labels \"org.opencontainers.image.revision\"}}\t{{index .Config.Labels \"io.memory-core.source-tree\"}}\t{{index .Config.Labels \"com.docker.compose.project\"}}\t{{index .Config.Labels \"com.docker.compose.service\"}}",
    containerId,
  ]);
  if (!commandPassed(container)) {
    return {
      passed: false,
      reason: "failed to inspect memory-core container provenance",
      containerId,
      commands: { ps: commandEvidence(ps), container: commandEvidence(container) },
    };
  }
  const [containerImageId, containerRevision, containerTree, composeProject, composeService] =
    container.stdout.trim().split("\t");
  const image = await run("docker", [
    "image", "inspect", "--format",
    "{{.Id}}\t{{index .Config.Labels \"org.opencontainers.image.revision\"}}\t{{index .Config.Labels \"io.memory-core.source-tree\"}}",
    containerImageId,
  ]);
  if (!commandPassed(image)) {
    return {
      passed: false,
      reason: "failed to inspect memory-core image provenance",
      containerId,
      containerImageId,
      commands: {
        ps: commandEvidence(ps),
        container: commandEvidence(container),
        image: commandEvidence(image),
      },
    };
  }
  const [imageId, imageRevision, imageTree] = image.stdout.trim().split("\t");
  const gates = {
    immutableImageId: /^sha256:[0-9a-f]{64}$/.test(imageId || "") && imageId === containerImageId,
    revisionMatchesRuntime: imageRevision === process.env.MC_GIT_SHA
      && containerRevision === process.env.MC_GIT_SHA,
    treeMatchesRuntime: imageTree === process.env.MC_GIT_TREE
      && containerTree === process.env.MC_GIT_TREE,
    composeProjectMatches: composeProject === expectedComposeProjectName,
    composeServiceMatches: composeService === "memory-core",
  };
  return {
    passed: Object.values(gates).every(Boolean),
    checkedAt: new Date().toISOString(),
    containerId,
    imageId,
    revision: imageRevision || null,
    tree: imageTree || null,
    gates,
    commands: {
      ps: commandEvidence(ps),
      container: commandEvidence(container),
      image: commandEvidence(image),
    },
  };
}

function commandEvidence(result) {
  return {
    code: result.code,
    signal: result.signal || null,
    timedOut: !!result.timedOut,
    error: result.error || null,
  };
}

function commandPassed(result) {
  return result.code === 0 && !result.signal && !result.error && !result.timedOut;
}

async function atomicJson(name, value) {
  const target = path.join(runDir, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function readJson(name) {
  try {
    return JSON.parse(await readFile(path.join(runDir, name), "utf8"));
  } catch {
    return null;
  }
}

async function setFault(value) {
  const previous = await readJson("fault-state.json") || {};
  await atomicJson("fault-state.json", { ...previous, ...value, updatedAt: new Date().toISOString() });
}

async function waitReady(timeoutMs = 300_000) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  while (performance.now() < deadline) {
    if (signalReceived) return { recovered: false, recoveryMs: performance.now() - started };
    try {
      const response = await fetch(`${required("MC_BASE_URL")}/ready`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return { recovered: true, recoveryMs: performance.now() - started };
    } catch { /* expected during a planned fault */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { recovered: false, recoveryMs: performance.now() - started };
}

function structuredPostFaultAudit(heartbeat, requestId, purpose) {
  const receipt = heartbeat?.lastCompletedAudit || heartbeat?.audit?.lastCompleted || null;
  const results = receipt?.results;
  const counters = heartbeat?.counters;
  const reasons = [];
  if (heartbeat?.lastCompletedAuditRequest !== requestId) reasons.push("heartbeat request id mismatch");
  if (receipt?.requestId !== requestId) reasons.push("audit receipt request id mismatch");
  if (receipt?.purpose !== purpose) reasons.push("audit purpose mismatch");
  if (receipt?.successful !== true) reasons.push("audit did not report success");
  if (!Number.isSafeInteger(receipt?.records) || receipt.records <= 0) reasons.push("audit records must be positive");
  if (!Number.isSafeInteger(receipt?.accountedRecords)
    || receipt.accountedRecords !== receipt.records) reasons.push("audit record accounting mismatch");
  if (!Number.isSafeInteger(results?.FOUND) || results.FOUND !== receipt?.records) {
    reasons.push("audit did not find every record");
  }
  if (results?.LOST !== 0) reasons.push("audit reported lost records");
  if (results?.UNVERIFIED !== 0) reasons.push("audit reported unverified records");
  if (counters?.acknowledgedLosses !== 0) reasons.push("oracle has acknowledged losses");
  if (counters?.auditUnverified !== 0) reasons.push("oracle has unverified audit records");
  if (heartbeat?.hardStopReason !== null) reasons.push("soak entered a hard-stop state");
  const requestedAtMs = Date.parse(receipt?.requestedAt || "");
  const startedAtMs = Date.parse(receipt?.startedAt || "");
  const completedAtMs = Date.parse(receipt?.completedAt || "");
  if (!Number.isFinite(requestedAtMs)
    || !Number.isFinite(startedAtMs)
    || !Number.isFinite(completedAtMs)
    || startedAtMs < requestedAtMs
    || completedAtMs < startedAtMs) reasons.push("audit timestamps are invalid");
  return {
    completed: heartbeat?.lastCompletedAuditRequest === requestId,
    passed: reasons.length === 0,
    requestId,
    purpose,
    reasons,
    receipt,
    heartbeat: {
      updatedAt: heartbeat?.updatedAt || null,
      acknowledgedLosses: counters?.acknowledgedLosses ?? null,
      auditUnverified: counters?.auditUnverified ?? null,
      hardStopReason: heartbeat?.hardStopReason ?? null,
    },
  };
}

async function waitAudit(requestId, purpose, timeoutMs = 300_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (signalReceived) {
      return {
        completed: false,
        passed: false,
        requestId,
        purpose,
        reasons: [`controller received ${signalReceived} while waiting for the audit`],
        receipt: null,
        heartbeat: null,
      };
    }
    const heartbeat = await readJson("heartbeat.json");
    if (heartbeat?.lastCompletedAuditRequest === requestId
      || heartbeat?.lastCompletedAudit?.requestId === requestId
      || heartbeat?.audit?.lastCompleted?.requestId === requestId) {
      return structuredPostFaultAudit(heartbeat, requestId, purpose);
    }
    const summary = await readJson("summary.json");
    if (summary?.result === "FAILED") {
      return {
        completed: false,
        passed: false,
        requestId,
        purpose,
        reasons: ["soak failed before completing the requested audit"],
        receipt: null,
        heartbeat: null,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return {
    completed: false,
    passed: false,
    requestId,
    purpose,
    reasons: ["timed out waiting for a structured post-fault audit"],
    receipt: null,
    heartbeat: null,
  };
}

function validateFrameworkSummary(summary) {
  const resultNames = Array.isArray(summary?.results) ? summary.results.map((result) => result?.name) : null;
  const gates = {
    runtimeContractValid: runtimeContract.valid,
    requiredSetMatchesBootstrap: exactStringSet(summary?.required, canonicalRequiredProbes),
    resultSetMatchesBootstrap: exactStringSet(resultNames, canonicalRequiredProbes),
    passedSetMatchesBootstrap: exactStringSet(summary?.passed, canonicalRequiredProbes),
    noRequiredFailures: Array.isArray(summary?.requiredFailed) && summary.requiredFailed.length === 0,
    noRequiredNotRun: Array.isArray(summary?.requiredNotRun) && summary.requiredNotRun.length === 0,
  };
  return { passed: Object.values(gates).every(Boolean), gates };
}

async function runProbes(reason, slot = null) {
  event("framework-probes-start", { reason, slot });
  const result = await run(process.execPath, [path.join(root, "bench", "framework-compat", "run-probes.mjs")], {
    limit: 2_000_000,
    timeoutMs: 20 * 60_000,
  });
  let summary = null;
  try {
    const line = result.stdout.trim().split("\n").findLast((candidate) => candidate.startsWith("{"));
    if (line) summary = JSON.parse(line);
  } catch { /* failure is recorded below */ }
  const contract = validateFrameworkSummary(summary);
  const passed = commandPassed(result)
    && summary?.status === "QUALIFIED_WITH_LIMITS"
    && contract.passed;
  const record = {
    reason,
    slot,
    at: new Date().toISOString(),
    monotonicSinceWorkloadMs: workloadAnchor ? performance.now() - workloadAnchor.performanceMs : null,
    passed,
    command: commandEvidence(result),
    contract,
    summary,
  };
  frameworkRuns.push(record);
  event("framework-probes-finish", record);
  return record;
}

async function serviceGeneration(service) {
  const ps = await compose("ps", "-q", service);
  if (!commandPassed(ps) || !ps.stdout.trim()) return { ok: false, service, command: commandEvidence(ps) };
  const containerId = ps.stdout.trim().split("\n")[0];
  const inspect = await run("docker", ["inspect", "--format", "{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}", containerId]);
  if (!commandPassed(inspect)) return { ok: false, service, containerId, command: commandEvidence(inspect) };
  const [id, startedAtValue, restartCountValue] = inspect.stdout.trim().split("|");
  const restartCount = Number(restartCountValue);
  if (!id || !startedAtValue || !Number.isSafeInteger(restartCount) || restartCount < 0) {
    return { ok: false, service, containerId, reason: "invalid container generation evidence" };
  }
  let postmasterStartedAt = null;
  if (service === "db") {
    const postgres = await compose(
      "exec", "-T", "db", "psql", "-U", "memory", "-d", "memory_core", "-Atc",
      "SELECT pg_postmaster_start_time()",
    );
    if (!commandPassed(postgres)) return { ok: false, service, containerId, command: commandEvidence(postgres) };
    postmasterStartedAt = postgres.stdout.trim();
  }
  return {
    ok: true,
    service,
    containerId: id || containerId,
    startedAt: startedAtValue,
    restartCount,
    postmasterStartedAt,
  };
}

function generationChanged(before, after) {
  if (!before.ok || !after.ok) return false;
  return before.containerId !== after.containerId
    || before.startedAt !== after.startedAt
    || before.restartCount !== after.restartCount
    || (before.service === "db" && before.postmasterStartedAt !== after.postmasterStartedAt);
}

function sameGeneration(expected, observed) {
  return !!expected?.ok && !!observed?.ok && !generationChanged(expected, observed);
}

function generationSnapshot(value) {
  if (!value) return null;
  return {
    ok: !!value.ok,
    service: value.service || null,
    containerId: value.containerId || null,
    startedAt: value.startedAt || null,
    restartCount: Number.isSafeInteger(value.restartCount) ? value.restartCount : null,
    postmasterStartedAt: value.postmasterStartedAt || null,
  };
}

function recordGenerationViolation(service, reason, expected, observed) {
  const violation = {
    at: new Date().toISOString(),
    monotonicSinceWorkloadMs: workloadAnchor ? performance.now() - workloadAnchor.performanceMs : null,
    service,
    reason,
    expected: generationSnapshot(expected),
    observed: generationSnapshot(observed),
  };
  generationMonitoring.violations.push(violation);
  event("generation-violation", violation);
  hardStopController(`unexpected ${service} generation state: ${reason}`);
}

async function checkGenerationContinuity(force = false) {
  if (!expectedGenerations || (!force && (ending || !workloadAnchor))) return;
  generationMonitoring.checks += 1;
  for (const service of ["memory-core", "db"]) {
    const observed = await serviceGeneration(service);
    if (plannedFault?.service === service) continue;
    const now = performance.now();
    if (!observed.ok) {
      generationMonitoring.failedServiceChecks += 1;
      const lastVerified = generationMonitoring.lastVerifiedAtMs[service];
      if (force || lastVerified === null || now - lastVerified > maximumResourceSuccessGapMs) {
        recordGenerationViolation(service, "generation could not be verified for 90 seconds", expectedGenerations[service], observed);
      }
      continue;
    }
    generationMonitoring.successfulServiceChecks += 1;
    generationMonitoring.lastVerifiedAtMs[service] = now;
    if (!sameGeneration(expectedGenerations[service], observed)) {
      recordGenerationViolation(service, "generation changed outside a planned fault", expectedGenerations[service], observed);
    }
  }
}

async function faultAction(name) {
  if (name === "app-graceful-restart") return [await compose("restart", "memory-core")];
  if (name === "app-sigkill") return [
    await compose("kill", "-s", "SIGKILL", "memory-core"),
    await compose("up", "-d", "--no-deps", "memory-core"),
  ];
  if (name === "db-graceful-restart") return [await compose("restart", "db")];
  return [
    await compose("kill", "-s", "SIGKILL", "db"),
    await compose("up", "-d", "--no-deps", "db"),
  ];
}

async function injectFault(name) {
  if (ending) return;
  const service = name.startsWith("app-") ? "memory-core" : "db";
  plannedFault = { name, service, startedAt: new Date().toISOString() };
  event("fault-start", { name, service });
  const before = await serviceGeneration(service);
  const baselineMatched = sameGeneration(expectedGenerations?.[service], before);
  if (!baselineMatched) {
    plannedFault = null;
    recordGenerationViolation(
      service,
      "generation did not match the expected baseline before the planned fault",
      expectedGenerations?.[service],
      before,
    );
    const record = {
      name,
      service,
      passed: false,
      commandsPassed: false,
      commands: [],
      actionError: "pre-fault generation baseline mismatch",
      recovered: false,
      recoveryMs: 0,
      generationChanged: false,
      baselineMatched: false,
      baselineUpdated: false,
      before,
      after: null,
      postFaultAuditCompleted: false,
      postFaultAuditPassed: false,
      postFaultAudit: null,
    };
    faults.push(record);
    event("fault-finish", record);
    return;
  }
  await setFault({ active: true, name, startedAt: new Date().toISOString() });
  let commands = [];
  let actionError = null;
  try {
    commands = await faultAction(name);
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  }
  const commandsPassed = !actionError && commands.length > 0 && commands.every(commandPassed);
  const readiness = commandsPassed ? await waitReady() : { recovered: false, recoveryMs: 0 };
  const after = readiness.recovered ? await serviceGeneration(service) : { ok: false, service };
  const changed = generationChanged(before, after);
  const baselineUpdated = commandsPassed && readiness.recovered && changed && after.ok;
  if (baselineUpdated) {
    expectedGenerations[service] = after;
    generationMonitoring.lastVerifiedAtMs[service] = performance.now();
    generationMonitoring.baselineUpdates.push({
      at: new Date().toISOString(),
      name,
      service,
      before: generationSnapshot(before),
      after: generationSnapshot(after),
    });
  }
  const auditRequest = `${name}:${randomUUID()}`;
  const auditPurpose = `post-fault:${name}`;
  await setFault({
    active: false,
    name: null,
    lastCompleted: name,
    completedAt: new Date().toISOString(),
    auditRequested: auditRequest,
    recovered: readiness.recovered,
  });
  plannedFault = null;
  const postFaultAudit = commandsPassed && readiness.recovered && changed && baselineUpdated
    ? await waitAudit(auditRequest, auditPurpose)
    : {
      completed: false,
      passed: false,
      requestId: auditRequest,
      purpose: auditPurpose,
      reasons: ["fault action, readiness recovery, and generation change are required before audit qualification"],
      receipt: null,
      heartbeat: null,
    };
  const passed = commandsPassed
    && readiness.recovered
    && changed
    && baselineUpdated
    && postFaultAudit.passed;
  const record = {
    name,
    service,
    passed,
    commandsPassed,
    commands: commands.map(commandEvidence),
    actionError,
    recovered: readiness.recovered,
    recoveryMs: readiness.recoveryMs,
    generationChanged: changed,
    baselineMatched,
    baselineUpdated,
    before,
    after,
    postFaultAuditCompleted: postFaultAudit.completed,
    postFaultAuditPassed: postFaultAudit.passed,
    postFaultAudit,
  };
  faults.push(record);
  event("fault-finish", record);
  if (!passed) hardStopController(`planned fault ${name} failed its recovery or audit gates`);
}

async function collectResources(force = false) {
  if (ending && !force) return;
  const sampledAtPerformance = performance.now();
  const [ps, stats, postgres] = await Promise.all([
    compose("ps", "--format", "json"),
    compose("stats", "--no-stream", "--format", "json", "memory-core", "db"),
    compose(
      "exec", "-T", "db", "psql", "-U", "memory", "-d", "memory_core", "-Atc",
      "SELECT json_build_object('connections',numbackends,'commits',xact_commit,'rollbacks',xact_rollback,'deadlocks',deadlocks,'temp_bytes',temp_bytes,'db_bytes',pg_database_size(current_database())) FROM pg_stat_database WHERE datname=current_database()",
    ),
  ]);
  const commands = [ps, stats, postgres].map(commandEvidence);
  const passed = [ps, stats, postgres].every(commandPassed);
  const monotonicSinceWorkloadMs = workloadAnchor
    ? sampledAtPerformance - workloadAnchor.performanceMs
    : null;
  resourceStats.attempted += 1;
  if (passed) {
    resourceStats.successful += 1;
    if (Number.isFinite(monotonicSinceWorkloadMs)) {
      resourceStats.successfulAtMs.push(Math.max(0, monotonicSinceWorkloadMs));
    }
  } else {
    resourceStats.failed += 1;
  }
  const record = {
    at: new Date().toISOString(),
    monotonicSinceWorkloadMs,
    passed,
    composePs: commandPassed(ps) ? ps.stdout.trim() : null,
    composeStats: commandPassed(stats) ? stats.stdout.trim().split("\n").filter(Boolean) : null,
    postgres: commandPassed(postgres) ? postgres.stdout.trim() : null,
    commands,
  };
  resourceEvents.write(`${JSON.stringify(record)}\n`);
  return record;
}

function queueMaintenance(kind, task) {
  const queuedAt = new Date().toISOString();
  const queued = maintenanceChain.then(async () => {
    if (ending) {
      event("maintenance-skipped", { kind, queuedAt, reason: "campaign ending" });
      return null;
    }
    const maintenanceStartedAt = new Date().toISOString();
    event("maintenance-start", { kind, queuedAt, maintenanceStartedAt });
    const result = await task();
    event("maintenance-finish", {
      kind,
      queuedAt,
      maintenanceStartedAt,
      maintenanceFinishedAt: new Date().toISOString(),
    });
    return result;
  });
  maintenanceChain = queued.catch((error) => {
    event("maintenance-controller-error", {
      kind,
      queuedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    hardStopController(`maintenance task ${kind} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  return maintenanceChain;
}

function schedule(afterSeconds, kind, task) {
  const delayMs = workloadAnchor
    ? Math.max(0, workloadAnchor.performanceMs + afterSeconds * 1000 - performance.now())
    : afterSeconds * 1000;
  const timer = setTimeout(() => {
    void queueMaintenance(kind, task);
  }, delayMs);
  timers.push(timer);
}

async function runToFile(command, args, target, options = {}) {
  const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
  await once(output, "open");
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let killTimer;
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: ["ignore", output.fd, output.fd],
    });
    activeChildren.add(child);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      output.end(async () => {
        let bytes = null;
        try { bytes = (await stat(target)).size; } catch { /* reflected by the command failure evidence */ }
        resolve({ ...value, timedOut, bytes });
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, options.timeoutMs || 20 * 60_000);
    child.on("error", (error) => finish({ code: null, signal: null, error: error.message }));
    child.on("close", (code, signal) => finish({ code, signal, error: null }));
  });
}

async function persistFinalEvidence() {
  const [ps, images, logs, postgres] = await Promise.all([
    compose("ps", "--format", "json"),
    compose("images", "--format", "json"),
    runToFile(
      "docker",
      [...composeBase, "logs", "--no-color", "--timestamps", "memory-core", "db"],
      path.join(runDir, "compose-final.log"),
    ),
    compose(
      "exec", "-T", "db", "psql", "-U", "memory", "-d", "memory_core", "-Atc",
      "SELECT json_build_object('active',count(*) FILTER (WHERE status='active'),'archived',count(*) FILTER (WHERE status='archived'),'superseded',count(*) FILTER (WHERE status='superseded'),'db_bytes',pg_database_size(current_database())) FROM memories",
    ),
  ]);
  const passed = [ps, images, logs, postgres].every(commandPassed);
  await Promise.all([
    writeFile(path.join(runDir, "compose-ps-final.jsonl"), ps.stdout || "", { mode: 0o600 }),
    writeFile(path.join(runDir, "compose-images-final.jsonl"), images.stdout || "", { mode: 0o600 }),
    writeFile(path.join(runDir, "postgres-final.json"), `${postgres.stdout.trim()}\n`, { mode: 0o600 }),
  ]);
  return { passed, commands: [ps, images, logs, postgres].map(commandEvidence) };
}

async function artifactManifest() {
  const manifestName = "artifact-manifest.sha256";
  const excludedTopLevel = new Set([
    "run.env", "cli-state", "framework-home", manifestName, "campaign.complete.json",
  ]);
  const files = [];
  async function walk(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (!relative && excludedTopLevel.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) files.push(childRelative);
    }
  }
  await walk(runDir);
  files.sort();
  const lines = [];
  for (const relative of files) {
    const file = path.join(runDir, relative);
    const metadata = await stat(file);
    lines.push(`${await sha256File(file)}  ${relative}  ${metadata.size}`);
  }
  const target = path.join(runDir, manifestName);
  await writeFile(target, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  return { path: manifestName, sha256: await sha256File(target), fileCount: lines.length };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function clearCampaignTimers() {
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  timers.length = 0;
}

function terminateActiveChildren(signal = "SIGTERM") {
  for (const child of [...activeChildren]) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill(signal);
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
    killTimer.unref();
  }
}

function hardStopController(reason) {
  if (controllerHardStopReason) {
    ending = true;
    clearCampaignTimers();
    terminateActiveChildren("SIGTERM");
    return;
  }
  controllerHardStopReason = reason;
  ending = true;
  event("campaign-hard-stop", { reason });
  clearCampaignTimers();
  terminateActiveChildren("SIGTERM");
}

async function waitForWorkloadRunning(timeoutMs = workloadStartupTimeoutMs) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  while (performance.now() < deadline) {
    if (signalReceived) {
      return { passed: false, reason: `controller received ${signalReceived} during startup`, waitedMs: performance.now() - started };
    }
    if (soakExitObserved) {
      return { passed: false, reason: "soak exited before entering WORKLOAD_RUNNING", waitedMs: performance.now() - started };
    }
    const heartbeat = await readJson("heartbeat.json");
    if (heartbeat?.runId === runId && heartbeat?.phase === "WORKLOAD_RUNNING") {
      const passed = heartbeat?.hardStopReason === null;
      return {
        passed,
        reason: passed ? null : "soak heartbeat entered WORKLOAD_RUNNING with a hard-stop reason",
        waitedMs: performance.now() - started,
        heartbeat: {
          updatedAt: heartbeat.updatedAt || null,
          phase: heartbeat.phase,
          phaseStartedAt: heartbeat.phaseStartedAt || null,
          timing: heartbeat.timing || null,
        },
      };
    }
    const summary = await readJson("summary.json");
    if (summary?.result === "FAILED") {
      return { passed: false, reason: "soak failed during startup", waitedMs: performance.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { passed: false, reason: "timed out waiting for WORKLOAD_RUNNING", waitedMs: performance.now() - started };
}

async function captureGenerationBaselines() {
  const [application, database] = await Promise.all([
    serviceGeneration("memory-core"),
    serviceGeneration("db"),
  ]);
  const passed = application.ok && database.ok;
  if (passed) {
    expectedGenerations = { "memory-core": application, db: database };
    const now = performance.now();
    generationMonitoring.lastVerifiedAtMs["memory-core"] = now;
    generationMonitoring.lastVerifiedAtMs.db = now;
  }
  return {
    passed,
    application: generationSnapshot(application),
    database: generationSnapshot(database),
  };
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (signalReceived) return;
    signalReceived = signal;
    event("campaign-signal", { signal });
    hardStopController(`controller received ${signal}`);
  });
}

event("campaign-start", {
  runId,
  durationSeconds,
  faultSchedule,
  profile: profile.name,
  composeProjectName: expectedComposeProjectName,
  sourceHead: sourceAtStart.head,
  sourceTree: sourceAtStart.tree,
  sourceClean: sourceAtStart.clean,
});
await setFault({ active: false, name: null });
let workloadStartup = { passed: false, reason: "soak was not started" };
let generationBaselines = { passed: false, application: null, database: null };
let soakExit = { code: null, signal: null, error: "soak was not started" };

if (!signalReceived) containerImageAtStart = await inspectContainerImageProvenance();
if (!signalReceived) await runProbes("startup");

if (!signalReceived) {
  soak = spawn(process.execPath, [path.join(root, "bench", "framework-compat", "soak.mjs")], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(soak);
  const soakStdout = createWriteStream(path.join(runDir, "soak.stdout.log"), { flags: "a", mode: 0o600 });
  const soakStderr = createWriteStream(path.join(runDir, "soak.stderr.log"), { flags: "a", mode: 0o600 });
  soakLogCompletion = Promise.allSettled([once(soakStdout, "finish"), once(soakStderr, "finish")]);
  soak.stdout.pipe(soakStdout);
  soak.stderr.pipe(soakStderr);
  soakExitPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(soak);
      soakExitObserved = value;
      resolve(value);
    };
    soak.on("error", (error) => finish({ code: null, signal: null, error: error.message }));
    soak.on("close", (code, signal) => finish({ code, signal, error: null }));
  });

  workloadStartup = await waitForWorkloadRunning();
  if (!workloadStartup.passed) {
    hardStopController(workloadStartup.reason);
  } else {
    workloadAnchor = {
      performanceMs: performance.now(),
      anchoredAt: new Date().toISOString(),
      heartbeat: workloadStartup.heartbeat,
    };
    generationBaselines = await captureGenerationBaselines();
    if (!generationBaselines.passed) {
      hardStopController("failed to capture app/database generation baselines");
    } else {
      const generationTimer = setInterval(() => {
        generationMonitorChain = generationMonitorChain.then(() => checkGenerationContinuity()).catch((error) => {
          hardStopController(`generation monitor failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, generationIntervalMs);
      timers.push(generationTimer);

      resourceCollection = resourceCollection.then(() => collectResources()).catch((error) => {
        event("resource-collection-error", { error: error instanceof Error ? error.message : String(error) });
      });
      await resourceCollection;
      const resourceTimer = setInterval(() => {
        resourceCollection = resourceCollection.then(() => collectResources()).catch((error) => {
          event("resource-collection-error", { error: error instanceof Error ? error.message : String(error) });
        });
      }, resourceIntervalMs);
      timers.push(resourceTimer);

      for (const slot of expectedPeriodicProbeSlots) {
        schedule(slot.atSeconds, `framework-reprobe:${slot.slot}`, () => runProbes("periodic", slot));
      }
      for (const fault of faultSchedule) {
        schedule(fault.atSeconds, `fault:${fault.name}`, () => injectFault(fault.name));
      }
    }
  }
  soakExit = await soakExitPromise;
} else {
  event("startup-aborted", { signal: signalReceived, reason: controllerHardStopReason });
}

ending = true;
clearCampaignTimers();
event("soak-finish", soakExit);
await Promise.allSettled([resourceCollection, maintenanceChain, generationMonitorChain, soakLogCompletion]);
await checkGenerationContinuity(true).catch((error) => {
  hardStopController(`final generation verification failed: ${error instanceof Error ? error.message : String(error)}`);
});
await collectResources(true).catch(() => {});
let finalEvidence;
try {
  finalEvidence = await persistFinalEvidence();
} catch (error) {
  finalEvidence = { passed: false, error: error instanceof Error ? error.message : String(error), commands: [] };
}
containerImageAtFinish = await inspectContainerImageProvenance();
const soakSummary = await readJson("summary.json");
const sourceAtFinish = await inspectSourceProvenance();

const startupFrameworkRuns = frameworkRuns.filter((runResult) => runResult.reason === "startup");
const periodicFrameworkRuns = frameworkRuns.filter((runResult) => runResult.reason === "periodic");
const periodicProbeSlotsGate = periodicFrameworkRuns.length === expectedPeriodicProbeSlots.length
  && expectedPeriodicProbeSlots.every((expected) => periodicFrameworkRuns.some((actual) =>
    actual.slot?.slot === expected.slot
    && actual.slot?.atSeconds === expected.atSeconds
    && Number.isFinite(actual.monotonicSinceWorkloadMs)
    && actual.monotonicSinceWorkloadMs >= expected.atSeconds * 1000 - 1_000));
const frameworkGate = startupFrameworkRuns.length === 1
  && periodicProbeSlotsGate
  && frameworkRuns.length === 1 + expectedPeriodicProbeSlots.length
  && frameworkRuns.every((runResult) => runResult.passed);
const runtimeFaultCountMatchesProfile = Number.isInteger(profile.expectedFaultCount)
  && faults.length === profile.expectedFaultCount
  && faultSchedule.length === profile.expectedFaultCount;
const structuredPostFaultAuditsGate = runtimeFaultCountMatchesProfile
  && faults.every((fault) => fault.postFaultAuditCompleted && fault.postFaultAuditPassed);
const faultsGate = runtimeFaultCountMatchesProfile
  && faults.every((fault) => fault.passed);
const monotonicDurationGate = Number.isFinite(soakSummary?.timing?.elapsedQualificationMs)
  && soakSummary.timing.elapsedQualificationMs >= durationSeconds * 1000
  && soakSummary?.gates?.fullConfiguredDuration === true;
const soakGate = soakExit.code === 0
  && !soakExit.signal
  && !soakExit.error
  && soakSummary?.result === "PASSED"
  && monotonicDurationGate;
const sourceRevisionMatches = !!sourceAtStart.head
  && sourceAtStart.head === process.env.MC_GIT_SHA
  && sourceAtFinish.head === process.env.MC_GIT_SHA;
const sourceTreeMatches = !!sourceAtStart.tree
  && sourceAtStart.tree === process.env.MC_GIT_TREE
  && sourceAtFinish.tree === process.env.MC_GIT_TREE;
const sourceHeadAndTreeStable = !!sourceAtStart.head
  && sourceAtStart.head === sourceAtFinish.head
  && sourceAtStart.tree === sourceAtFinish.tree;
const sourceAttestationMatches = process.env.MC_SOURCE_STATE === "clean"
  && bootstrapManifest?.gitSha === process.env.MC_GIT_SHA
  && bootstrapManifest?.gitTree === process.env.MC_GIT_TREE
  && bootstrapManifest?.sourceState === "clean";
const sourceGate = sourceAtStart.ok
  && sourceAtStart.clean
  && sourceAtFinish.ok
  && sourceAtFinish.clean
  && sourceRevisionMatches
  && sourceTreeMatches
  && sourceHeadAndTreeStable
  && sourceAttestationMatches;

const containerImageStable = !!containerImageAtStart?.passed
  && !!containerImageAtFinish?.passed
  && containerImageAtStart.imageId === containerImageAtFinish.imageId
  && containerImageAtStart.revision === containerImageAtFinish.revision
  && containerImageAtStart.tree === containerImageAtFinish.tree;
const generationContinuityGate = generationBaselines.passed
  && plannedFault === null
  && generationMonitoring.violations.length === 0;

const expectedResourceSamples = 1 + Math.floor((durationSeconds * 1000 - 1) / resourceIntervalMs);
const minimumSuccessfulResourceSamples = Math.ceil(expectedResourceSamples * 0.95);
const successfulResourceTimes = resourceStats.successfulAtMs
  .filter(Number.isFinite)
  .map((value) => Math.min(durationSeconds * 1000, Math.max(0, value)))
  .sort((left, right) => left - right);
let maximumSuccessfulResourceGapMs = null;
if (successfulResourceTimes.length > 0) {
  const points = [0, ...successfulResourceTimes, durationSeconds * 1000];
  maximumSuccessfulResourceGapMs = points.slice(1)
    .reduce((maximum, value, index) => Math.max(maximum, value - points[index]), 0);
}
const resourceCoverageGate = resourceStats.successful >= minimumSuccessfulResourceSamples
  && maximumSuccessfulResourceGapMs !== null
  && maximumSuccessfulResourceGapMs <= maximumResourceSuccessGapMs;

const operationalPassed = !signalReceived
  && !controllerHardStopReason
  && profile.valid
  && runtimeContract.valid
  && workloadStartup.passed
  && frameworkGate
  && faultsGate
  && structuredPostFaultAuditsGate
  && soakGate
  && sourceGate
  && containerImageStable
  && generationContinuityGate
  && resourceCoverageGate
  && finalEvidence.passed;
const primaryQualification = operationalPassed
  && profile.name === "primary"
  && profile.scheduleMatchesProfile
  && profile.configuredFaultCountMatchesProfile
  && runtimeFaultCountMatchesProfile
  && durationSeconds >= profileContracts.primary.minimumDurationSeconds
  && monotonicDurationGate;
const result = !operationalPassed
  ? "FAILED"
  : primaryQualification
    ? "PASSED"
    : profile.expectedResult;
const campaignSucceeded = result !== "FAILED";
const campaignSummary = {
  schemaVersion: 3,
  runId,
  result,
  qualified: result === "PASSED",
  startedAt,
  finishedAt: new Date().toISOString(),
  configuredDurationSeconds: durationSeconds,
  source: {
    declared: {
      gitSha: process.env.MC_GIT_SHA || null,
      gitTree: process.env.MC_GIT_TREE || null,
      state: process.env.MC_SOURCE_STATE || null,
      diffSha256: process.env.MC_SOURCE_DIFF_SHA256 || null,
    },
    bootstrap: bootstrapManifest ? {
      gitSha: bootstrapManifest.gitSha || null,
      gitTree: bootstrapManifest.gitTree || null,
      state: bootstrapManifest.sourceState || null,
      diffSha256: bootstrapManifest.sourceDiffSha256 || null,
    } : null,
    observedAtStart: sourceAtStart,
    observedAtFinish: sourceAtFinish,
  },
  runtimeContract,
  profile,
  compose: {
    declaredProjectName: declaredComposeProjectName,
    expectedProjectName: expectedComposeProjectName,
    verified: profile.composeProjectNameVerified,
  },
  containerImage: {
    start: containerImageAtStart,
    finish: containerImageAtFinish,
    stable: containerImageStable,
  },
  workloadStartup,
  workloadAnchor: workloadAnchor ? {
    anchoredAt: workloadAnchor.anchoredAt,
    heartbeat: workloadAnchor.heartbeat,
  } : null,
  soakExit,
  soakResult: soakSummary?.result || "NOT_AVAILABLE",
  frameworkRuns,
  faults,
  generation: {
    baselines: generationBaselines,
    expectedFinal: expectedGenerations ? {
      application: generationSnapshot(expectedGenerations["memory-core"]),
      database: generationSnapshot(expectedGenerations.db),
    } : null,
    monitoring: generationMonitoring,
  },
  resources: {
    attempted: resourceStats.attempted,
    successful: resourceStats.successful,
    failed: resourceStats.failed,
    expectedSamples: expectedResourceSamples,
    minimumSuccessfulSamples: minimumSuccessfulResourceSamples,
    maximumSuccessfulGapMs: maximumSuccessfulResourceGapMs,
    maximumAllowedGapMs: maximumResourceSuccessGapMs,
  },
  expectedPeriodicProbeSlots,
  finalEvidence,
  signalReceived,
  controllerHardStopReason,
  gates: {
    sourceTreeClean: sourceGate,
    sourceRevisionMatches,
    sourceTreeMatches,
    sourceHeadAndTreeStable,
    sourceAttestationMatches,
    runtimeContractValid: runtimeContract.valid,
    profileContractValid: profile.valid,
    bootstrapManifestMatchesRuntime: profile.bootstrapMatchesRuntime,
    composeProjectNameVerified: profile.composeProjectNameVerified,
    profileScheduleMatches: profile.scheduleMatchesProfile,
    configuredFaultCountMatchesProfile: profile.configuredFaultCountMatchesProfile,
    runtimeFaultCountMatchesProfile,
    profileMinimumDurationConfigured: profile.durationMinimumMet,
    workloadRunningPhaseObserved: workloadStartup.passed,
    frameworkProbesPassed: frameworkGate,
    periodicProbeSlotsComplete: periodicProbeSlotsGate,
    allScheduledFaultsPassed: faultsGate,
    structuredPostFaultAuditsPassed: structuredPostFaultAuditsGate,
    monotonicConfiguredDurationCompleted: monotonicDurationGate,
    soakPassedFullDuration: soakGate,
    containerImageProvenanceStable: containerImageStable,
    generationContinuityPreserved: generationContinuityGate,
    resourceCoveragePassed: resourceCoverageGate,
    finalEvidenceComplete: finalEvidence.passed,
    noControllerSignal: !signalReceived,
    noControllerHardStop: !controllerHardStopReason,
    operationalPass: operationalPassed,
    primaryQualification,
  },
  claimLimits: [
    "Claude Code and Codex CLI configuration-only L0 results are not protocol compatibility.",
    "Hermes and OpenClaw L1 discovery results are not deterministic tool execution.",
    "No autonomous model-driven L3 result is claimed.",
  ],
};
await atomicJson("campaign-summary.json", campaignSummary);
event("campaign-finish", { result: campaignSummary.result, gates: campaignSummary.gates });
await new Promise((resolve) => campaignEvents.end(resolve));
await new Promise((resolve) => resourceEvents.end(resolve));
const artifactManifestEvidence = await artifactManifest();
const campaignSummaryEvidence = {
  path: "campaign-summary.json",
  sha256: await sha256File(path.join(runDir, "campaign-summary.json")),
};
if (signalReceived && campaignSummary.signalReceived === null) {
  throw new Error(`controller received ${signalReceived} after campaign-summary.json was finalized`);
}
await writeFile(path.join(runDir, "campaign.complete.json"), `${JSON.stringify({
  schemaVersion: 1,
  status: "COMPLETE",
  runId,
  result: campaignSummary.result,
  qualified: campaignSummary.qualified,
  completedAt: new Date().toISOString(),
  campaignSummary: campaignSummaryEvidence,
  artifactManifest: artifactManifestEvidence,
}, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.exitCode = campaignSucceeded ? 0 : 2;
