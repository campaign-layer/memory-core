#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 15) || (nodeMajor === 25 && nodeMinor < 9)) {
  throw new Error(`the full compatibility harness requires Node >=24.15; found ${process.version}`);
}
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const REQUIRED_PROBES = [
  "generic-mcp",
  "langchain",
  "langgraph",
  "openai-agents",
  "openai-agents-adapter",
  "autogen",
  "crewai",
  "claude-code",
  "codex-cli",
  "hermes",
  "openclaw",
];
const EXPECTED_VERSIONS = {
  MC_EXPECTED_MCP_SDK_VERSION: "1.30.0",
  MC_EXPECTED_LANGCHAIN_MCP_VERSION: "1.1.4",
  MC_EXPECTED_LANGGRAPH_VERSION: "1.4.13",
  MC_EXPECTED_OPENAI_AGENTS_VERSION: "0.17.0",
  AUTOGEN_EXPECTED_VERSION: "0.7.5",
  CREWAI_EXPECTED_VERSION: "1.15.18",
  CLAUDE_EXPECTED_VERSION: "2.1.251",
  CODEX_EXPECTED_VERSION: "0.151.0",
  OPENCLAW_EXPECTED_VERSION: "2026.7.1-2",
  HERMES_EXPECTED_VERSION: "0.19.0",
};

const APPS = [
  "generic-mcp",
  "langchain",
  "langgraph",
  "openai-agents",
  "autogen",
  "crewai",
  "claude-code",
  "codex-cli",
  "openclaw",
  "hermes",
];

function option(name, fallback) {
  const flag = `--${name}`;
  const indexes = process.argv.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length > 1) throw new Error(`${flag} may only be provided once`);
  if (indexes.length === 0) return fallback;
  const value = process.argv[indexes[0] + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function boundedInteger(name, fallback, min, max) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "unknown git error").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return String(result.stdout).trim();
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function effectiveDestination(candidate) {
  const suffix = [];
  let cursor = candidate;
  while (true) {
    try {
      return path.resolve(await realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

const runId = option("run-id", new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"));
if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId)) throw new Error("--run-id contains unsafe characters");
const outputOption = option("output");
if (!outputOption) throw new Error("--output is required and must point outside the repository");
if (/[\r\n]/.test(outputOption)) throw new Error("--output must not contain line breaks");
const output = path.resolve(outputOption);
const repositoryRealPath = await realpath(repositoryRoot);
const effectiveOutput = await effectiveDestination(output);
if (isInside(repositoryRealPath, effectiveOutput)) {
  throw new Error("--output must point outside the repository, including through symlinks");
}
const port = boundedInteger("port", 17_401, 1, 65_535);
const durationSeconds = boundedInteger("duration-seconds", 86_400, 60, 604_800);
const rps = boundedInteger("rps", 2, 1, 100);
const concurrency = boundedInteger("concurrency", 4, 1, 64);

const gitTopLevel = await realpath(gitOutput(["rev-parse", "--show-toplevel"]));
if (gitTopLevel !== repositoryRealPath) {
  throw new Error(`expected Git root ${repositoryRealPath}, found ${gitTopLevel}`);
}
const gitSha = gitOutput(["rev-parse", "--verify", "HEAD"]);
const gitTree = gitOutput(["rev-parse", "--verify", "HEAD^{tree}"]);
if (!/^[0-9a-f]{40}$/.test(gitSha) || !/^[0-9a-f]{40}$/.test(gitTree)) {
  throw new Error("Git HEAD and HEAD^{tree} must be full 40-character lowercase object IDs");
}
const sourceStatus = gitOutput([
  "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
]);
if (sourceStatus) throw new Error("repository must be clean, including untracked files, before generating a run");
const verifiedGitSha = gitOutput(["rev-parse", "--verify", "HEAD"]);
const verifiedGitTree = gitOutput(["rev-parse", "--verify", "HEAD^{tree}"]);
if (verifiedGitSha !== gitSha || verifiedGitTree !== gitTree) {
  throw new Error("Git HEAD changed while source provenance was being verified");
}
if (gitOutput(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) {
  throw new Error("repository changed while source provenance was being verified");
}
const declaredGitSha = option("git-sha", process.env.MC_GIT_SHA);
if (declaredGitSha && declaredGitSha !== gitSha) {
  throw new Error(`declared Git revision does not match clean HEAD ${gitSha}`);
}
const declaredGitTree = option("git-tree", process.env.MC_GIT_TREE);
if (declaredGitTree && declaredGitTree !== gitTree) {
  throw new Error(`declared Git tree does not match clean HEAD^{tree} ${gitTree}`);
}
const declaredSourceState = option("source-state", "clean");
if (declaredSourceState !== "clean") throw new Error("--source-state must be clean");
const declaredSourceDiffSha256 = option("source-diff-sha256", "none");
if (declaredSourceDiffSha256 !== "none") throw new Error("--source-diff-sha256 must be none for a clean source tree");
const sourceState = "clean";
const sourceDiffSha256 = "none";
const autogenPython = option("autogen-python", process.env.AUTOGEN_PYTHON);
const crewaiPython = option("crewai-python", process.env.CREWAI_PYTHON);
const claudeBin = option("claude-bin", process.env.CLAUDE_BIN);
const codexBin = option("codex-bin", process.env.CODEX_BIN);
const hermesBin = option("hermes-bin", process.env.HERMES_BIN);
const openclawBin = option("openclaw-bin", process.env.OPENCLAW_BIN);
const postgresImage = option("postgres-image", process.env.POSTGRES_IMAGE || "pgvector/pgvector:pg16");
if (!postgresImage || /\s/.test(postgresImage)) throw new Error("--postgres-image must be a non-empty image reference without whitespace");
const faultProfile = option("fault-profile", "primary");
if (!["none", "canary", "primary"].includes(faultProfile)) throw new Error("--fault-profile must be none, canary, or primary");
if (faultProfile !== "none" && !/@sha256:[0-9a-f]{64}$/.test(postgresImage)) {
  throw new Error("canary and primary profiles require --postgres-image with an immutable @sha256:<64 lowercase hex> digest");
}
const faultSchedules = {
  none: [],
  canary: [
    { atSeconds: 60, name: "app-graceful-restart" },
    { atSeconds: 150, name: "app-sigkill" },
    { atSeconds: 300, name: "db-graceful-restart" },
    { atSeconds: 450, name: "db-sigkill" },
  ],
  primary: [
    { atSeconds: 7_200, name: "app-graceful-restart" },
    { atSeconds: 21_600, name: "app-sigkill" },
    { atSeconds: 43_200, name: "db-graceful-restart" },
    { atSeconds: 64_800, name: "db-sigkill" },
  ],
};
if (faultProfile === "primary" && durationSeconds < 86_400) {
  throw new Error("the primary qualification profile requires at least 86400 seconds");
}
if (faultProfile === "canary" && durationSeconds < 600) {
  throw new Error("the canary profile requires at least 600 seconds");
}
if (faultSchedules[faultProfile].some(({ atSeconds }) => atSeconds >= durationSeconds)) {
  throw new Error(`the ${faultProfile} fault schedule does not fit inside --duration-seconds`);
}
const composeProjectName = `mc-compat-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
const baseUrl = `http://127.0.0.1:${port}`;
const reprobeSeconds = faultProfile === "canary" ? durationSeconds : 18_000;
const runtimeContract = {
  gitSha,
  gitTree,
  composeProjectName,
  baseUrl,
  port,
  durationSeconds,
  rps,
  concurrency,
  postgresImage,
  reprobeSeconds,
  requiredProbes: REQUIRED_PROBES,
  expectedVersions: EXPECTED_VERSIONS,
};

const principals = [];
for (const tenantId of ["bench-a", "bench-b"]) {
  for (const space of ["one", "two"]) {
    for (const actorId of ["alice", "bob"]) {
      for (const appId of APPS) {
        principals.push({
          key: randomBytes(32).toString("hex"),
          tenantId,
          spaceId: `${tenantId}-space-${space}`,
          appId,
          actorId,
        });
      }
    }
  }
}

const postgresPassword = randomBytes(32).toString("hex");
const principalsJson = JSON.stringify(principals);
const envLines = [
  `COMPOSE_PROJECT_NAME=${composeProjectName}`,
  `MC_RUN_ID=${runId}`,
  `MC_GIT_SHA=${gitSha}`,
  `MC_GIT_TREE=${gitTree}`,
  `MC_SOURCE_STATE=${sourceState}`,
  `MC_SOURCE_DIFF_SHA256=${sourceDiffSha256}`,
  `MC_PORT=${port}`,
  `MC_BASE_URL=${baseUrl}`,
  `MC_DURATION_SECONDS=${durationSeconds}`,
  `MC_RPS=${rps}`,
  `MC_CONCURRENCY=${concurrency}`,
  `MC_RUN_DIR=${output}`,
  `MEMORY_CORE_ROOT=${repositoryRoot}`,
  `NODE_BIN=${process.execPath}`,
  `MC_REQUIRED_PROBES=${REQUIRED_PROBES.join(",")}`,
  `MC_FAULT_PROFILE=${faultProfile}`,
  `MC_FAULT_SCHEDULE_JSON=${JSON.stringify(faultSchedules[faultProfile])}`,
  `MC_REPROBE_SECONDS=${reprobeSeconds}`,
  ...Object.entries(EXPECTED_VERSIONS).map(([name, version]) => `${name}=${version}`),
  `MC_RUNTIME_CONTRACT_JSON=${JSON.stringify(runtimeContract)}`,
  ...(autogenPython ? [`AUTOGEN_PYTHON=${path.resolve(autogenPython)}`] : []),
  ...(crewaiPython ? [`CREWAI_PYTHON=${path.resolve(crewaiPython)}`] : []),
  ...(claudeBin ? [`CLAUDE_BIN=${path.resolve(claudeBin)}`] : []),
  ...(codexBin ? [`CODEX_BIN=${path.resolve(codexBin)}`] : []),
  ...(hermesBin ? [`HERMES_BIN=${path.resolve(hermesBin)}`] : []),
  ...(openclawBin ? [`OPENCLAW_BIN=${path.resolve(openclawBin)}`] : []),
  `POSTGRES_IMAGE=${postgresImage}`,
  `POSTGRES_PASSWORD=${postgresPassword}`,
  `MEMORY_PG_URL=postgres://memory:${postgresPassword}@db:5432/memory_core`,
  `MEMORY_CORE_PRINCIPAL_API_KEYS=${principalsJson}`,
  `BENCH_PRINCIPALS_JSON=${principalsJson}`,
  "MEMORY_RATE_LIMIT_PER_MIN=10000",
  "MEMORY_ENV=production",
  "MEMORY_PROVIDER=postgres",
  "MEMORY_PG_AUTO_MIGRATE=false",
  "MEMORY_EMBEDDER=none",
  "MEMORY_EXTRACTOR=none",
];
if (envLines.some((line) => /[\r\n]/.test(line))) {
  throw new Error("generated run.env entries must not contain line breaks");
}

await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(path.join(output, "run.env"), `${envLines.join("\n")}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
await writeFile(
  path.join(output, "principals.sanitized.json"),
  `${JSON.stringify(principals.map(({ key: _key, ...identity }) => identity), null, 2)}\n`,
  { encoding: "utf8", mode: 0o600, flag: "wx" },
);
await writeFile(
  path.join(output, "manifest.bootstrap.json"),
  `${JSON.stringify({
    schemaVersion: 2,
    runId,
    createdAt: new Date().toISOString(),
    gitSha,
    gitTree,
    sourceState,
    sourceDiffSha256,
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    port,
    durationSeconds,
    rps,
    concurrency,
    principalCount: principals.length,
    apps: APPS,
    requiredProbes: REQUIRED_PROBES,
    faultProfile,
    faultSchedule: faultSchedules[faultProfile],
    composeProjectName,
    postgresImage,
    runtimeContract,
    config: {
      environment: "production",
      provider: "postgres",
      autoMigrate: false,
      embedder: "none",
      extractor: "none",
      listener: `127.0.0.1:${port}`,
    },
  }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600, flag: "wx" },
);

process.stdout.write(`${JSON.stringify({
  runId,
  output,
  gitSha,
  gitTree,
  principalCount: principals.length,
  runtimeContract,
})}\n`);
