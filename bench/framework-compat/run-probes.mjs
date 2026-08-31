#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

process.umask(0o077);
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 15) || (nodeMajor === 25 && nodeMinor < 9)) {
  throw new Error(`the full compatibility harness requires Node >=24.15; found ${process.version}`);
}

const runDir = path.resolve(required("MC_RUN_DIR"));
const root = path.resolve(required("MEMORY_CORE_ROOT"));
const here = path.join(root, "bench", "framework-compat");
const timeoutMs = Number(process.env.FRAMEWORK_PROBE_TIMEOUT_MS || 120_000);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(runDir, "framework-probes", stamp);
const principals = JSON.parse(required("BENCH_PRINCIPALS_JSON"));
if (!Array.isArray(principals)) throw new Error("BENCH_PRINCIPALS_JSON must be an array");
const redactionSecrets = [
  ...principals.map((principal) => principal.key),
  process.env.POSTGRES_PASSWORD,
  process.env.MEMORY_PG_URL,
].filter(Boolean).sort((a, b) => b.length - a.length);
await mkdir(outputDir, { recursive: true, mode: 0o700 });

const definitions = [
  { name: "generic-mcp", appId: "generic-mcp", expectedLevel: "L2", command: process.execPath, expectedVersionEnvs: ["MC_EXPECTED_MCP_SDK_VERSION"], args: [path.join(here, "probe-js.mjs"), "generic-mcp"] },
  { name: "langchain", appId: "langchain", expectedLevel: "L2", command: process.execPath, expectedVersionEnvs: ["MC_EXPECTED_LANGCHAIN_MCP_VERSION"], args: [path.join(here, "probe-js.mjs"), "langchain"] },
  { name: "langgraph", appId: "langgraph", expectedLevel: "L2", command: process.execPath, expectedVersionEnvs: ["MC_EXPECTED_LANGGRAPH_VERSION", "MC_EXPECTED_LANGCHAIN_MCP_VERSION"], args: [path.join(here, "probe-js.mjs"), "langgraph"] },
  { name: "openai-agents", appId: "openai-agents", expectedLevel: "L2", command: process.execPath, expectedVersionEnvs: ["MC_EXPECTED_OPENAI_AGENTS_VERSION"], args: [path.join(here, "probe-js.mjs"), "openai-agents"] },
  { name: "openai-agents-adapter", appId: "openai-agents", expectedLevel: "L2", command: process.execPath, expectedVersionEnvs: ["MC_EXPECTED_OPENAI_AGENTS_VERSION"], args: [path.join(here, "probe-openai-runner.mjs")] },
  { name: "autogen", appId: "autogen", expectedLevel: "L2", commandEnv: "AUTOGEN_PYTHON", expectedVersionEnvs: ["AUTOGEN_EXPECTED_VERSION"], args: [path.join(here, "probe-python.py"), "autogen"] },
  { name: "crewai", appId: "crewai", expectedLevel: "L2", commandEnv: "CREWAI_PYTHON", expectedVersionEnvs: ["CREWAI_EXPECTED_VERSION"], args: [path.join(here, "probe-python.py"), "crewai"] },
  { name: "claude-code", appId: "claude-code", expectedLevel: "L0", command: process.execPath, cliEnv: "CLAUDE_BIN", expectedVersionEnvs: ["CLAUDE_EXPECTED_VERSION"], args: [path.join(here, "probe-cli.mjs"), "claude-code"] },
  { name: "codex-cli", appId: "codex-cli", expectedLevel: "L0", command: process.execPath, cliEnv: "CODEX_BIN", expectedVersionEnvs: ["CODEX_EXPECTED_VERSION"], args: [path.join(here, "probe-cli.mjs"), "codex-cli"] },
  { name: "hermes", appId: "hermes", expectedLevel: "L1", command: process.execPath, cliEnv: "HERMES_BIN", expectedVersionEnvs: ["HERMES_EXPECTED_VERSION"], args: [path.join(here, "probe-cli.mjs"), "hermes"] },
  { name: "openclaw", appId: "openclaw", expectedLevel: "L1", command: process.execPath, cliEnv: "OPENCLAW_BIN", expectedVersionEnvs: ["OPENCLAW_EXPECTED_VERSION"], args: [path.join(here, "probe-cli.mjs"), "openclaw"] },
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function principalFor(appId) {
  const principal = principals.find((candidate) => candidate.appId === appId);
  if (!principal) throw new Error(`no principal configured for appId=${appId}`);
  return principal;
}

function levelRank(level) {
  return ({ L0: 0, L1: 1, L2: 2, L3: 3 })[level] ?? -1;
}

function redact(value) {
  let output = String(value || "");
  for (const secret of redactionSecrets) output = output.split(secret).join("[REDACTED]");
  return output
    .replace(/(MEMORY_CORE_API_KEY[=:]\s*)\S+/g, "$1[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/g, "$1[REDACTED]$2");
}

async function childEnv(definition) {
  const home = path.join(runDir, "framework-home", stamp, definition.name);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    TMPDIR: process.env.TMPDIR || "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    NO_COLOR: "1",
    MEMORY_CORE_ROOT: root,
    MC_BASE_URL: required("MC_BASE_URL"),
    MC_RUN_DIR: runDir,
    MC_FRAMEWORK_PROBE_INSTANCE: stamp,
    NODE_BIN: process.env.NODE_BIN || process.execPath,
    BENCH_PRINCIPAL_JSON: JSON.stringify(principalFor(definition.appId)),
  };
  if (definition.cliEnv) env[definition.cliEnv] = process.env[definition.cliEnv];
  for (const name of definition.expectedVersionEnvs || []) env[name] = required(name);
  return env;
}

function execute(definition, command, env) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(command, definition.args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const appendBounded = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish({
        name: definition.name,
        expectedLevel: definition.expectedLevel,
        meetsExpectedLevel: false,
        passed: false,
        available: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: redact(error.message),
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      let parsed = null;
      const sentinel = stdout.split("\n").findLast((line) => line.startsWith("@@MEMORY_CORE_PROBE@@"));
      try {
        if (sentinel) parsed = JSON.parse(sentinel.slice("@@MEMORY_CORE_PROBE@@".length));
      } catch { /* redacted raw transcript is retained */ }
      const passed = !timedOut && code === 0 && parsed?.passed === true;
      finish({
        name: definition.name,
        expectedLevel: definition.expectedLevel,
        meetsExpectedLevel: passed && levelRank(parsed?.level) >= levelRank(definition.expectedLevel),
        passed,
        available: code !== null && code !== 126 && code !== 127,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: code,
        signal,
        timedOut,
        result: parsed,
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });
  });
}

const requiredNames = new Set((process.env.MC_REQUIRED_PROBES || definitions.slice(0, 5).map((item) => item.name).join(","))
  .split(",").map((name) => name.trim()).filter(Boolean));
const unknownRequired = [...requiredNames].filter((name) => !definitions.some((item) => item.name === name));
if (unknownRequired.length) throw new Error(`MC_REQUIRED_PROBES contains unknown names: ${unknownRequired.join(",")}`);

const results = [];
const notRun = [];
for (const definition of definitions) {
  const command = definition.commandEnv ? process.env[definition.commandEnv] : definition.command;
  const available = command && (!definition.cliEnv || process.env[definition.cliEnv]);
  if (!available) {
    notRun.push({ name: definition.name, reason: definition.commandEnv || definition.cliEnv || "not configured" });
    continue;
  }
  const result = await execute(definition, command, await childEnv(definition));
  results.push(result);
  await writeFile(path.join(outputDir, `${definition.name}.json`), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
}

const requiredNotRun = notRun.filter((item) => requiredNames.has(item.name)).map((item) => item.name);
const failed = results.filter((result) => !result.passed || !result.meetsExpectedLevel).map((result) => result.name);
const requiredFailed = failed.filter((name) => requiredNames.has(name));
const summary = {
  schemaVersion: 2,
  startedAt: results[0]?.startedAt || new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  status: requiredFailed.length ? "FAILED" : requiredNotRun.length ? "INCOMPLETE" : "QUALIFIED_WITH_LIMITS",
  required: [...requiredNames],
  passed: results.filter((result) => result.passed && result.meetsExpectedLevel).map((result) => result.name),
  l2Passed: results.filter((result) => result.passed && result.result?.level === "L2").map((result) => result.name),
  l1Passed: results.filter((result) => result.passed && result.result?.level === "L1").map((result) => result.name),
  l0Only: results.filter((result) => result.passed && result.result?.level === "L0").map((result) => result.name),
  failed,
  requiredFailed,
  notRun,
  requiredNotRun,
  claimLimit: "L0 configuration results are not protocol compatibility; L1 discovery is not tool execution; no result is L3 autonomous model selection.",
  results: results.map(({ stdout: _stdout, stderr: _stderr, ...result }) => result),
};
await writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exitCode = summary.status === "QUALIFIED_WITH_LIMITS" ? 0 : 1;
