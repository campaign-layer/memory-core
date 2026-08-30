import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_TOOLS = [
  "build_context",
  "feedback",
  "forget",
  "recall",
  "remember",
  "supersede",
];

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(process.env.MEMORY_CORE_ROOT || path.join(here, "../.."));
export const serverPath = path.join(repoRoot, "dist/integrations/mcp-server.js");
process.umask(0o077);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function principalFor(appId) {
  const principal = JSON.parse(required("BENCH_PRINCIPAL_JSON"));
  if (principal.appId !== appId) {
    throw new Error(`probe principal appId=${principal.appId} does not match ${appId}`);
  }
  return principal;
}

export function serverEnv(appId) {
  const principal = principalFor(appId);
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    MEMORY_CORE_MODE: "remote",
    MEMORY_CORE_URL: required("MC_BASE_URL"),
    MEMORY_CORE_API_KEY: principal.key,
    MEMORY_TENANT_ID: principal.tenantId,
    MEMORY_SPACE_ID: principal.spaceId,
    MEMORY_APP_ID: principal.appId,
    MEMORY_ACTOR_ID: principal.actorId,
    MEMORY_THREAD_ID: `framework-probe-${appId}`,
    MEMORY_SOURCE_TYPE: `framework-probe:${appId}`,
  };
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    return value.content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n");
  }
  return JSON.stringify(value);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export async function attestInstalledPackageVersion(packageName, expectedVersionEnv) {
  const expected = required(expectedVersionEnv);
  const manifestPath = path.join(here, "node_modules", packageName, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  check(manifest.name === packageName, `installed package metadata did not identify ${packageName}`);
  const actual = String(manifest.version || "");
  check(actual, `${packageName} package metadata did not contain a version`);
  check(
    actual === expected,
    `${packageName} installed version ${actual} does not match ${expectedVersionEnv}=${expected}`,
  );
  return {
    package: packageName,
    actual,
    expected,
    expectedFrom: expectedVersionEnv,
    matched: true,
  };
}

export async function exerciseFramework({
  framework,
  principalAppId = framework,
  version,
  versionAttestation,
  toolNames,
  call,
  close,
}) {
  const startedAt = new Date().toISOString();
  let names = [];
  let marker;
  let memoryId;
  let replacementId;
  let cleanupCompleted = false;
  let primaryError;
  try {
    names = [...toolNames].sort();
    check(
      JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS),
      `tool surface mismatch: got ${names.join(",")}`,
    );

    let malformedRejected = false;
    try {
      const malformed = await call("remember", { text: "no" });
      malformedRejected = malformed?.isError === true || /failed|invalid|at least/i.test(textOf(malformed));
    } catch {
      malformedRejected = true;
    }
    check(malformedRejected, "malformed remember input was not rejected");

    marker = `compat-${framework}-${Date.now()}-${randomUUID()}`;
    const remembered = textOf(await call("remember", {
      text: `Framework ${framework} remembers marker ${marker}`,
      type: "tool_outcome",
      scope: "actor",
      importance: 0.8,
    }));
    memoryId = /id=(\S+)/.exec(remembered)?.[1];
    check(memoryId, "remember did not return an id");
    check((await getRemoteMemory(principalAppId, memoryId))?.id === memoryId, "remembered id was not readable through REST");

    const recalled = textOf(await call("recall", { query: marker, limit: 5 }));
    check(recalled.includes(marker), "recall did not return the marker");

    const context = textOf(await call("build_context", {
      query: marker,
      maxItems: 5,
      maxChars: 1000,
    }));
    check(context.includes(marker), "build_context did not return the marker");

    const feedback = textOf(await call("feedback", { memoryId, signal: "useful" }));
    check(!/failed|error/i.test(feedback), "feedback returned an error");

    const replacement = `${marker}-corrected`;
    const superseded = textOf(await call("supersede", {
      memoryId,
      newText: `Framework ${framework} corrected marker ${replacement}`,
      reason: "compatibility probe",
    }));
    replacementId = /id=(\S+)/.exec(superseded)?.[1];
    check(replacementId, "supersede did not return a replacement id");
    check(await getRemoteMemory(principalAppId, memoryId) === null, "superseded id remained active through REST");
    check((await getRemoteMemory(principalAppId, replacementId))?.id === replacementId, "replacement id was not active through REST");

    const corrected = textOf(await call("recall", { query: replacement, limit: 5 }));
    check(corrected.includes(replacement), "corrected memory was not recalled");
    check(!corrected.includes(`marker ${marker}\n`), "superseded text remained visible");

    const forgotten = textOf(await call("forget", {
      memoryId: replacementId,
      reason: "compatibility probe cleanup",
    }));
    check(!/failed|error/i.test(forgotten), "forget returned an error");

    const afterForget = textOf(await call("recall", { query: replacement, limit: 5 }));
    check(!afterForget.includes(replacement), "forgotten memory remained visible");
    check(await getRemoteMemory(principalAppId, replacementId) === null, "forgotten id remained active through REST");
    cleanupCompleted = true;

    return {
      framework,
      version,
      versionAttestation,
      level: "L2",
      passed: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      tools: names,
      checks: [
        "list-tools",
        "malformed-input",
        "remember",
        "recall",
        "build-context",
        "feedback",
        "supersede",
        "forget",
        "rest-lifecycle-corroboration",
        ...(versionAttestation?.length ? ["installed-version-attestation"] : []),
      ],
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!cleanupCompleted) {
      const cleanupIds = [...new Set([replacementId, memoryId].filter(Boolean))];
      for (const cleanupId of cleanupIds) {
        try {
          await call("forget", { memoryId: cleanupId, reason: "compatibility probe failure cleanup" });
        } catch { /* preserve the original probe failure */ }
      }
    }
    try {
      await close?.();
    } catch (closeError) {
      if (!primaryError) throw closeError;
    }
  }
}

async function getRemoteMemory(appId, memoryId) {
  const principal = principalFor(appId);
  const response = await fetch(`${required("MC_BASE_URL").replace(/\/$/, "")}/v1/memory/get`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": principal.key },
    body: JSON.stringify({
      memoryId,
      tenantId: principal.tenantId,
      spaceId: principal.spaceId,
      appId: principal.appId,
      actorId: principal.actorId,
    }),
  });
  if (!response.ok) throw new Error(`REST lifecycle check returned ${response.status}`);
  return (await response.json()).memory ?? null;
}

export function emit(result) {
  process.stdout.write(`@@MEMORY_CORE_PROBE@@${JSON.stringify(result)}\n`);
}

export function fail(framework, error) {
  emit({
    framework,
    level: "L0",
    passed: false,
    finishedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
