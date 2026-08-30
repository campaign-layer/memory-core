#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { emit, EXPECTED_TOOLS, fail, principalFor, serverEnv, serverPath } from "./probe-lib.mjs";

process.umask(0o077);

const framework = process.argv[2];
const settings = {
  "claude-code": {
    binEnv: "CLAUDE_BIN",
    expectedVersionEnv: "CLAUDE_EXPECTED_VERSION",
    appId: "claude-code",
    level: "L0",
  },
  "codex-cli": {
    binEnv: "CODEX_BIN",
    expectedVersionEnv: "CODEX_EXPECTED_VERSION",
    appId: "codex-cli",
    level: "L0",
  },
  hermes: {
    binEnv: "HERMES_BIN",
    expectedVersionEnv: "HERMES_EXPECTED_VERSION",
    appId: "hermes",
    level: "L1",
  },
  openclaw: {
    binEnv: "OPENCLAW_BIN",
    expectedVersionEnv: "OPENCLAW_EXPECTED_VERSION",
    appId: "openclaw",
    level: "L1",
  },
}[framework];
if (!settings) throw new Error("usage: probe-cli.mjs claude-code|codex-cli|hermes|openclaw");

const bin = process.env[settings.binEnv];
if (!bin) {
  fail(framework, new Error(`${settings.binEnv} is not configured`));
} else {
  try {
    const runDir = path.resolve(process.env.MC_RUN_DIR || ".");
    const instance = process.env.MC_FRAMEWORK_PROBE_INSTANCE || `${Date.now()}-${process.pid}`;
    const stateDir = path.join(runDir, "cli-state", instance, framework);
    const transcriptDir = path.join(runDir, "cli-transcripts", instance);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(transcriptDir, { recursive: true, mode: 0o700 });
    const principal = principalFor(settings.appId);
    const memoryEnv = serverEnv(settings.appId);
    const secrets = [principal.key];
    const proxyConfigPath = path.join(stateDir, "proxy-config.json");
    const proxyWrapperPath = path.join(stateDir, "proxy-wrapper.mjs");
    await writeFile(proxyConfigPath, `${JSON.stringify({
      node: process.env.NODE_BIN || process.execPath,
      serverPath,
      env: memoryEnv,
    })}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(proxyWrapperPath, proxyWrapperSource(), { mode: 0o700, flag: "wx" });
    const proxyCommand = process.env.NODE_BIN || process.execPath;

    const versionResult = await execute(bin, ["--version"], hostEnv(stateDir));
    if (versionResult.code !== 0) throw new Error(`${framework} --version failed`);
    const versionAttestation = [attestCliVersion(versionResult, settings.expectedVersionEnv)];

    let configure;
    let verify;
    if (framework === "claude-code") {
      configure = await execute(bin, [
        "mcp", "add", "--transport", "stdio", "--scope", "user",
        "memory-core", "--", proxyCommand, proxyWrapperPath,
      ], hostEnv(stateDir));
      verify = await execute(bin, ["mcp", "get", "memory-core"], hostEnv(stateDir));
    } else if (framework === "codex-cli") {
      configure = await execute(bin, [
        "mcp", "add", "memory-core",
        "--", proxyCommand, proxyWrapperPath,
      ], hostEnv(stateDir));
      verify = await execute(bin, ["mcp", "get", "memory-core", "--json"], hostEnv(stateDir));
    } else if (framework === "hermes") {
      configure = await execute(bin, [
        "mcp", "add", "memory-core",
        "--command", proxyCommand,
        "--connect-timeout", "30",
        "--args", proxyWrapperPath,
      ], hostEnv(stateDir), 60_000, "Y\n");
      verify = await execute(bin, ["mcp", "test", "memory-core"], hostEnv(stateDir), 60_000);
    } else {
      configure = await execute(bin, [
        "mcp", "add", "memory-core",
        "--command", proxyCommand,
        "--arg", proxyWrapperPath,
        "--include", EXPECTED_TOOLS.join(","),
      ], hostEnv(stateDir), 60_000);
      verify = await execute(bin, ["mcp", "probe", "memory-core", "--json"], hostEnv(stateDir), 60_000);
    }

    const transcript = redact([
      `$ ${framework} --version\n${versionResult.stdout}\n${versionResult.stderr}`,
      `$ configure [arguments redacted]\n${configure.stdout}\n${configure.stderr}`,
      `$ verify\n${verify.stdout}\n${verify.stderr}`,
    ].join("\n"), secrets);
    await writeFile(path.join(transcriptDir, `${framework}.log`), transcript, { mode: 0o600 });

    if (configure.code !== 0 || verify.code !== 0) {
      throw new Error(`${framework} config/verification failed (configure=${configure.code}, verify=${verify.code})`);
    }
    const verifierText = redact(verify.stdout, secrets);
    const verifierError = redact(verify.stderr, secrets);
    const discovered = settings.level === "L1"
      ? parseDiscoveredTools(framework, verifierText, verifierError)
      : [];
    if (settings.level === "L1" && discovered.length !== EXPECTED_TOOLS.length) {
      throw new Error(`${framework} did not report all six tools`);
    }
    emit({
      framework,
      version: versionAttestation[0].actual,
      versionAttestation,
      level: settings.level,
      passed: true,
      finishedAt: new Date().toISOString(),
      tools: discovered,
      checks: settings.level === "L1"
        ? ["installed-version-attestation", "isolated-config", "real-host-connect", "tools-list"]
        : ["installed-version-attestation", "isolated-config", "config-readback"],
      claimLimit: settings.level === "L0"
        ? "configuration accepted; no real host discovery or tool execution is claimed"
        : "host discovery only; deterministic tool execution and model choice are not claimed",
    });
  } catch (error) {
    fail(framework, error);
  }
}

function attestCliVersion(result, expectedVersionEnv) {
  const expected = process.env[expectedVersionEnv];
  if (!expected) throw new Error(`${expectedVersionEnv} is required`);
  const output = `${result.stdout}\n${result.stderr}`;
  const versions = [...output.matchAll(
    /(?<![0-9A-Za-z.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)(?![0-9A-Za-z.])/g,
  )].map((match) => match[1]);
  const actual = versions[0];
  if (!actual) throw new Error(`${framework} --version did not report a semantic version`);
  if (actual !== expected) {
    throw new Error(`${framework} installed version ${actual} does not match ${expectedVersionEnv}=${expected}`);
  }
  return {
    actual,
    expected,
    expectedFrom: expectedVersionEnv,
    matched: true,
  };
}

function hostEnv(stateDir) {
  const nodeDir = path.dirname(process.env.NODE_BIN || process.execPath);
  const hostPath = (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(path.delimiter);
  const env = {
    PATH: [nodeDir, ...hostPath.filter((entry) => entry !== nodeDir)].join(path.delimiter),
    HOME: stateDir,
    XDG_CONFIG_HOME: path.join(stateDir, "xdg-config"),
    XDG_DATA_HOME: path.join(stateDir, "xdg-data"),
    XDG_CACHE_HOME: path.join(stateDir, "xdg-cache"),
    TMPDIR: process.env.TMPDIR || "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    NO_COLOR: "1",
  };
  if (framework === "claude-code") env.CLAUDE_CONFIG_DIR = stateDir;
  if (framework === "codex-cli") env.CODEX_HOME = stateDir;
  if (framework === "hermes") env.HERMES_HOME = stateDir;
  if (framework === "openclaw") env.OPENCLAW_STATE_DIR = stateDir;
  return env;
}

function execute(command, args, env, timeoutMs = 30_000, input = "") {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    if (input) child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function redact(text, secrets) {
  let output = text;
  for (const secret of secrets) output = output.split(secret).join("[REDACTED]");
  return output.replace(/(MEMORY_CORE_API_KEY[=:]\s*)\S+/g, "$1[REDACTED]");
}

function parseDiscoveredTools(host, text, stderr) {
  if (/cancelled|not found|failed|error/i.test(`${text}\n${stderr}`)) return [];
  if (host === "openclaw") {
    try {
      const payload = JSON.parse(text.trim());
      if (!Array.isArray(payload.diagnostics) || payload.diagnostics.length !== 0) return [];
      if (payload.servers?.["memory-core"]?.tools !== EXPECTED_TOOLS.length) return [];
      const names = (payload.tools || []).map((name) => String(name).replace(/^memory-core__/, "")).sort();
      return JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS) ? names : [];
    } catch {
      return [];
    }
  }
  if (!/connected/i.test(text) || !/tools discovered:\s*6\b/i.test(text)) return [];
  // Only verifier output is inspected. Configuration output (including an
  // echoed --include list) can never manufacture an L1 discovery result.
  return EXPECTED_TOOLS.filter((name) => new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text));
}

function proxyWrapperSource() {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(here, "proxy-config.json"), "utf8"));
const child = spawn(config.node, [config.serverPath], {
  env: config.env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  process.stderr.write(\`memory-core proxy failed: \${error.message}\\n\`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
`;
}
