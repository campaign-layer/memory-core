#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

process.umask(0o077);

const EXCLUDED_TOP_LEVEL = ["run.env", "cli-state", "framework-home"];
const ALLOWED_TOP_LEVEL_FILES = new Set([
  "artifact-manifest.sha256",
  "campaign.complete.json",
  "campaign-summary.json",
  "campaign.ndjson",
  "campaign.started.json",
  "compose-final.log",
  "compose-images-final.jsonl",
  "compose-ps-final.jsonl",
  "fault-state.json",
  "heartbeat.json",
  "manifest.bootstrap.json",
  "oracle.ndjson",
  "postgres-final.json",
  "principals.sanitized.json",
  "requests.ndjson",
  "resources.ndjson",
  "runtime-autogen-freeze.txt",
  "runtime-crewai-freeze.txt",
  "runtime-framework-npm.json",
  "runtime-hermes-freeze.txt",
  "runtime-node-version.txt",
  "runtime-root-npm.json",
  "soak.stderr.log",
  "soak.stdout.log",
  "summary.json",
]);
const REQUIRED_EVIDENCE = [
  "artifact-manifest.sha256",
  "campaign.complete.json",
  "campaign.ndjson",
  "campaign-summary.json",
  "campaign.started.json",
  "compose-final.log",
  "compose-images-final.jsonl",
  "compose-ps-final.jsonl",
  "fault-state.json",
  "manifest.bootstrap.json",
  "oracle.ndjson",
  "postgres-final.json",
  "principals.sanitized.json",
  "requests.ndjson",
  "resources.ndjson",
  "runtime-autogen-freeze.txt",
  "runtime-crewai-freeze.txt",
  "runtime-framework-npm.json",
  "runtime-hermes-freeze.txt",
  "runtime-node-version.txt",
  "runtime-root-npm.json",
  "soak.stderr.log",
  "soak.stdout.log",
  "summary.json",
];
const REQUIRED_SECRET_ENV = [
  "POSTGRES_PASSWORD",
  "MEMORY_PG_URL",
  "MEMORY_CORE_PRINCIPAL_API_KEYS",
  "BENCH_PRINCIPALS_JSON",
];
const MAX_EVIDENCE_FILES = 10_000;
const MAX_EVIDENCE_BYTES = 20 * 1024 ** 3;
const MIN_SCANNABLE_SECRET_LENGTH = 8;

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument !== "--run-dir" && argument !== "--output") {
      throw new Error(`unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    const key = argument === "--run-dir" ? "runDir" : "output";
    if (options[key]) throw new Error(`${argument} may be supplied only once`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function pathMetadata(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseRunEnvironment(contents) {
  const values = new Map();
  for (const [index, rawLine] of contents.split("\n").entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`run.env has a malformed entry on line ${index + 1}`);
    const name = line.slice(0, separator);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`run.env has an unsafe variable name on line ${index + 1}`);
    }
    if (values.has(name)) throw new Error(`run.env contains duplicate variable ${name}`);
    values.set(name, line.slice(separator + 1));
  }
  for (const name of REQUIRED_SECRET_ENV) {
    if (!values.get(name)) throw new Error(`run.env is missing required secret-bearing variable ${name}`);
  }
  return values;
}

function secretPatterns(environment) {
  const patterns = new Map();
  const sourceNames = new Set();

  function add(value, source, variants = true) {
    if (typeof value !== "string" || value.length === 0) return;
    if (value.length < MIN_SCANNABLE_SECRET_LENGTH) {
      throw new Error(`${source} is too short for a safe artifact scan`);
    }
    sourceNames.add(source.match(/^[A-Z0-9_]+/)?.[0] || "structured-secret");
    const candidates = [[value, source]];
    if (variants) {
      const encoded = encodeURIComponent(value);
      if (encoded !== value) candidates.push([encoded, `${source}:url-encoded`]);
      if (value.length <= 4_096) {
        candidates.push([Buffer.from(value, "utf8").toString("base64"), `${source}:base64`]);
      }
    }
    for (const [candidate, label] of candidates) {
      if (candidate.length < MIN_SCANNABLE_SECRET_LENGTH) continue;
      const existing = patterns.get(candidate);
      if (existing) existing.add(label);
      else patterns.set(candidate, new Set([label]));
    }
  }

  function collectStructured(value, source) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => collectStructured(item, `${source}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [name, child] of Object.entries(value)) {
      const childSource = `${source}.${name}`;
      if (typeof child === "string"
        && /^(?:apiKey|api_key|key|password|secret|token|credential|privateKey)$/i.test(name)) {
        add(child, childSource);
      } else {
        collectStructured(child, childSource);
      }
    }
  }

  const sensitiveName = /PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|API_KEY|PRIVATE_KEY|PG_URL|DATABASE_URL/i;
  for (const [name, value] of environment) {
    if (sensitiveName.test(name) || name === "BENCH_PRINCIPALS_JSON") add(value, name);
  }

  for (const name of ["MEMORY_CORE_PRINCIPAL_API_KEYS", "BENCH_PRINCIPALS_JSON"]) {
    let parsed;
    try {
      parsed = JSON.parse(environment.get(name));
    } catch {
      throw new Error(`${name} is not valid JSON; refusing to produce a bundle`);
    }
    collectStructured(parsed, name);
  }

  try {
    const databaseUrl = new URL(environment.get("MEMORY_PG_URL"));
    const password = decodeURIComponent(databaseUrl.password || "");
    const username = decodeURIComponent(databaseUrl.username || "");
    add(password, "MEMORY_PG_URL.password");
    if (username && password) add(Buffer.from(`${username}:${password}`, "utf8").toString("base64"), "MEMORY_PG_URL.basic-auth", false);
  } catch {
    throw new Error("MEMORY_PG_URL is invalid; refusing to produce a bundle");
  }

  if (patterns.size === 0) throw new Error("no secret patterns were derived from run.env");
  return {
    values: [...patterns.entries()].map(([value, labels]) => ({ value, labels: [...labels].sort() }))
      .sort((left, right) => right.value.length - left.value.length),
    sourceNames: [...sourceNames].sort(),
  };
}

async function collectEvidence(runDirectory) {
  const files = [];
  const metadata = new Map();
  let ignoredFileCount = 0;
  let totalBytes = 0;

  function add(relative, details) {
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`allowlisted evidence is not a regular file: ${relative}`);
    }
    files.push(relative);
    metadata.set(relative, details);
    totalBytes += details.size;
    if (files.length > MAX_EVIDENCE_FILES) throw new Error("artifact allowlist exceeds the file-count safety limit");
    if (totalBytes > MAX_EVIDENCE_BYTES) throw new Error("artifact allowlist exceeds the byte safety limit");
  }

  for (const name of ALLOWED_TOP_LEVEL_FILES) {
    const details = await pathMetadata(path.join(runDirectory, name));
    if (details) add(name, details);
  }

  const probesRoot = path.join(runDirectory, "framework-probes");
  const probesMetadata = await pathMetadata(probesRoot);
  if (probesMetadata) {
    if (!probesMetadata.isDirectory() || probesMetadata.isSymbolicLink()) {
      throw new Error("framework-probes must be a real directory");
    }
    async function walk(directory, relativeDirectory, depth) {
      if (depth > 3) throw new Error("framework-probes exceeds the allowed directory depth");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) {
          throw new Error("framework-probes contains an unsafe path component");
        }
        const relative = path.join(relativeDirectory, entry.name);
        const child = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`framework-probes contains a symbolic link: ${relative}`);
        if (entry.isDirectory()) {
          await walk(child, relative, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          add(relative, await lstat(child));
        } else if (entry.isFile()) {
          ignoredFileCount += 1;
        } else {
          throw new Error(`framework-probes contains a special file: ${relative}`);
        }
      }
    }
    await walk(probesRoot, "framework-probes", 1);
  }

  const transcriptsRoot = path.join(runDirectory, "cli-transcripts");
  const transcriptsMetadata = await pathMetadata(transcriptsRoot);
  if (transcriptsMetadata) {
    if (!transcriptsMetadata.isDirectory() || transcriptsMetadata.isSymbolicLink()) {
      throw new Error("cli-transcripts must be a real directory");
    }
    async function walk(directory, relativeDirectory, depth) {
      if (depth > 3) throw new Error("cli-transcripts exceeds the allowed directory depth");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) {
          throw new Error("cli-transcripts contains an unsafe path component");
        }
        const relative = path.join(relativeDirectory, entry.name);
        const child = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`cli-transcripts contains a symbolic link: ${relative}`);
        if (entry.isDirectory()) {
          await walk(child, relative, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".log")) {
          add(relative, await lstat(child));
        } else if (entry.isFile()) {
          ignoredFileCount += 1;
        } else {
          throw new Error(`cli-transcripts contains a special file: ${relative}`);
        }
      }
    }
    await walk(transcriptsRoot, "cli-transcripts", 1);
  }

  for (const required of REQUIRED_EVIDENCE) {
    if (!metadata.has(required)) throw new Error(`required evidence is missing: ${required}`);
  }
  if (!files.some((relative) => (
    relative.startsWith(`framework-probes${path.sep}`)
    && relative.endsWith(`${path.sep}summary.json`)
  ))) {
    throw new Error("required framework probe summary evidence is missing");
  }
  for (const host of ["claude-code", "codex-cli", "hermes", "openclaw"]) {
    if (!files.some((relative) => (
      relative.startsWith(`cli-transcripts${path.sep}`)
      && path.basename(relative) === `${host}.log`
    ))) {
      throw new Error(`required redacted CLI transcript is missing: ${host}`);
    }
  }
  files.sort();
  return { files, metadata, ignoredFileCount, totalBytes };
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function parseArtifactManifest(contents) {
  const entries = new Map();
  for (const [index, line] of contents.trimEnd().split("\n").entries()) {
    const match = /^([0-9a-f]{64})  (.+)  ([0-9]+)$/.exec(line);
    if (!match) throw new Error(`artifact manifest line ${index + 1} is malformed`);
    const relative = match[2];
    if (path.isAbsolute(relative) || relative.split(path.sep).includes("..") || entries.has(relative)) {
      throw new Error(`artifact manifest line ${index + 1} contains an unsafe or duplicate path`);
    }
    entries.set(relative, { sha256: match[1], bytes: Number(match[3]) });
  }
  if (entries.size === 0) throw new Error("artifact manifest is empty");
  return entries;
}

async function verifyTerminalEvidence(runDirectory, evidenceFiles) {
  const [terminalContents, summaryContents, artifactContents] = await Promise.all([
    readFile(path.join(runDirectory, "campaign.complete.json"), "utf8"),
    readFile(path.join(runDirectory, "campaign-summary.json"), "utf8"),
    readFile(path.join(runDirectory, "artifact-manifest.sha256"), "utf8"),
  ]);
  let terminal;
  let summary;
  try {
    terminal = JSON.parse(terminalContents);
    summary = JSON.parse(summaryContents);
  } catch {
    throw new Error("campaign completion or summary evidence is not valid JSON");
  }
  if (terminal?.schemaVersion !== 1 || terminal?.status !== "COMPLETE") {
    throw new Error("campaign terminal marker is not COMPLETE");
  }
  if (terminal?.campaignSummary?.path !== "campaign-summary.json"
    || terminal.campaignSummary.sha256 !== await sha256File(path.join(runDirectory, "campaign-summary.json"))) {
    throw new Error("campaign terminal marker does not attest the campaign summary");
  }
  if (terminal?.artifactManifest?.path !== "artifact-manifest.sha256"
    || terminal.artifactManifest.sha256 !== await sha256File(path.join(runDirectory, "artifact-manifest.sha256"))) {
    throw new Error("campaign terminal marker does not attest the artifact manifest");
  }
  if (terminal.runId !== summary.runId
    || terminal.result !== summary.result
    || terminal.qualified !== summary.qualified) {
    throw new Error("campaign terminal marker and summary verdict disagree");
  }
  const entries = parseArtifactManifest(artifactContents);
  if (terminal.artifactManifest.fileCount !== entries.size) {
    throw new Error("campaign terminal marker has the wrong artifact file count");
  }
  for (const relative of evidenceFiles) {
    if (relative === "artifact-manifest.sha256" || relative === "campaign.complete.json") continue;
    const expected = entries.get(relative);
    if (!expected) throw new Error(`artifact manifest does not attest required evidence: ${relative}`);
    const evidencePath = path.join(runDirectory, relative);
    const details = await lstat(evidencePath);
    if (details.size !== expected.bytes || await sha256File(evidencePath) !== expected.sha256) {
      throw new Error(`artifact manifest hash/size mismatch: ${relative}`);
    }
  }
  return { terminal, summary, artifactEntryCount: entries.size };
}

function scanText(contents, relative, secrets) {
  for (const secret of secrets) {
    if (contents.includes(secret.value)) {
      throw new Error(`secret material from ${secret.labels.join("/")} detected in ${relative}`);
    }
  }
}

async function hashAndScan(file, relative, secrets, maximumSecretLength) {
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let tail = "";
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    if (chunk.includes(0)) throw new Error(`binary content is not allowed in sanitized evidence: ${relative}`);
    hash.update(chunk);
    size += chunk.length;
    const text = `${tail}${decoder.write(chunk)}`;
    scanText(text, relative, secrets);
    tail = maximumSecretLength > 1 ? text.slice(-(maximumSecretLength - 1)) : "";
  }
  const finalText = `${tail}${decoder.end()}`;
  if (finalText) scanText(finalText, relative, secrets);
  return { relative, bytes: size, sha256: hash.digest("hex") };
}

async function copyStable(source, destination, before, relative) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const after = await lstat(source);
  if (!after.isFile()
    || after.isSymbolicLink()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`source evidence changed while it was copied: ${relative}`);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: bundle-artifacts.mjs --run-dir DIR --output DIR\n");
    return;
  }
  const requestedRunDirectory = options.runDir || process.env.MC_RUN_DIR;
  if (!requestedRunDirectory) throw new Error("--run-dir or MC_RUN_DIR is required");
  const runDirectory = await realpath(path.resolve(requestedRunDirectory));
  const requestedOutput = path.resolve(options.output || process.env.MC_BUNDLE_DIR || `${runDirectory}.review-bundle`);
  if (requestedOutput === path.parse(requestedOutput).root) throw new Error("refusing to use a filesystem root as output");
  const outputParent = await realpath(path.dirname(requestedOutput));
  const outputDirectory = path.join(outputParent, path.basename(requestedOutput));
  if (isWithin(runDirectory, outputDirectory) || isWithin(outputDirectory, runDirectory)) {
    throw new Error("bundle output and live run directory must not contain one another");
  }
  if (await pathMetadata(outputDirectory)) throw new Error("bundle output already exists");

  const runEnvironmentPath = path.join(runDirectory, "run.env");
  const runEnvironmentMetadata = await lstat(runEnvironmentPath);
  if (!runEnvironmentMetadata.isFile() || runEnvironmentMetadata.isSymbolicLink()) {
    throw new Error("run.env must be a regular file");
  }
  if ((runEnvironmentMetadata.mode & 0o077) !== 0) {
    throw new Error("run.env must not be readable or writable by group or other users");
  }
  const environment = parseRunEnvironment(await readFile(runEnvironmentPath, "utf8"));
  const secretSet = secretPatterns(environment);
  const maximumSecretLength = Math.max(...secretSet.values.map((item) => item.value.length));
  const evidence = await collectEvidence(runDirectory);
  const terminalEvidence = await verifyTerminalEvidence(runDirectory, evidence.files);
  for (const relative of evidence.files) scanText(relative, "artifact path", secretSet.values);

  const stagingDirectory = path.join(
    outputParent,
    `.${path.basename(outputDirectory)}.staging-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  await mkdir(stagingDirectory, { mode: 0o700 });
  try {
    for (const relative of evidence.files) {
      await copyStable(
        path.join(runDirectory, relative),
        path.join(stagingDirectory, relative),
        evidence.metadata.get(relative),
        relative,
      );
    }

    const fileEvidence = [];
    for (const relative of evidence.files) {
      fileEvidence.push(await hashAndScan(
        path.join(stagingDirectory, relative),
        relative,
        secretSet.values,
        maximumSecretLength,
      ));
    }
    const checksums = `${fileEvidence.map((item) => `${item.sha256}  ${item.relative}`).join("\n")}\n`;
    scanText(checksums, "SHA256SUMS", secretSet.values);
    await writeFile(path.join(stagingDirectory, "SHA256SUMS"), checksums, { mode: 0o600, flag: "wx" });

    const manifest = {
      schemaVersion: 1,
      status: "SANITIZED",
      createdAt: new Date().toISOString(),
      allowlistVersion: 1,
      exclusions: EXCLUDED_TOP_LEVEL,
      ignoredNonAllowlistedFileCount: evidence.ignoredFileCount,
      secretPatternCount: secretSet.values.length,
      secretSources: secretSet.sourceNames,
      files: fileEvidence,
      totalEvidenceBytes: fileEvidence.reduce((sum, item) => sum + item.bytes, 0),
      checksumFile: {
        name: "SHA256SUMS",
        sha256: createHash("sha256").update(checksums).digest("hex"),
      },
      campaign: {
        runId: terminalEvidence.terminal.runId,
        result: terminalEvidence.terminal.result,
        qualified: terminalEvidence.terminal.qualified,
        completedAt: terminalEvidence.terminal.completedAt,
        artifactEntryCount: terminalEvidence.artifactEntryCount,
      },
    };
    const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
    scanText(manifestContents, "bundle-manifest.json", secretSet.values);
    await writeFile(path.join(stagingDirectory, "bundle-manifest.json"), manifestContents, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(stagingDirectory, outputDirectory);
    process.stdout.write(`${JSON.stringify({
      status: "SANITIZED",
      output: outputDirectory,
      files: fileEvidence.length,
      bytes: manifest.totalEvidenceBytes,
      secretPatternsScanned: secretSet.values.length,
    })}\n`);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "FAILED",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 2;
});
