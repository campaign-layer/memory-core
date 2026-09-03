export interface ModeARunIdentity {
  repoSha: string;
  repoRoot: string;
  datasetSha: string;
  seed: number;
}

export interface ModeARowStamp {
  qid?: unknown;
  error?: unknown;
  repoSha?: unknown;
  repoRoot?: unknown;
  datasetSha?: unknown;
  seed?: unknown;
}

export function parseNonNegativeInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseSystemNames(raw: string): string[] {
  const systems = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (systems.length === 0) throw new Error("--systems must name at least one system");
  if (new Set(systems).size !== systems.length) {
    throw new Error(`--systems contains duplicates: ${raw}`);
  }
  return systems;
}

export function parseSubsetQuestionIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("subset must be a JSON array of question ids");
  if (value.length === 0) throw new Error("subset must contain at least one question id");
  if (value.some((qid) => typeof qid !== "string" || qid.length === 0)) {
    throw new Error("subset question ids must be non-empty strings");
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new Error("subset contains duplicate question ids");
  return ids;
}

/** One deterministic selection rule shared by workers and aggregation. */
export function selectQuestionIds(
  availableQuestionIds: readonly string[],
  subsetQuestionIds: readonly string[] | null,
  limit: number,
): string[] {
  const available = new Set(availableQuestionIds);
  let selected = [...available].sort();

  if (subsetQuestionIds) {
    const unknown = subsetQuestionIds.filter((qid) => !available.has(qid));
    if (unknown.length > 0) {
      throw new Error(`subset contains unknown question id(s): ${unknown.join(", ")}`);
    }
    const keep = new Set(subsetQuestionIds);
    selected = selected.filter((qid) => keep.has(qid));
  }

  if (limit > 0) selected = selected.slice(0, limit);
  if (selected.length === 0) throw new Error("question selection is empty");
  return selected;
}

export function datasetShaFromManifest(manifest: any): string {
  const sha = manifest?.provenance?.dataset?.sha256;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new Error("prepared LongMemEval manifest has no dataset sha256");
  }
  return sha;
}

export function rowMatchesRun(row: ModeARowStamp, expected: ModeARunIdentity): boolean {
  return row.repoSha === expected.repoSha &&
    row.repoRoot === expected.repoRoot &&
    row.datasetSha === expected.datasetSha &&
    row.seed === expected.seed;
}

export function systemRunFailures(
  system: string,
  rows: readonly ModeARowStamp[],
  expectedQuestionIds: readonly string[],
  identity: ModeARunIdentity,
): string[] {
  const failures: string[] = [];
  const expected = new Set(expectedQuestionIds);
  const counts = new Map<string, number>();
  let invalidQuestionIds = 0;
  for (const row of rows) {
    if (typeof row.qid !== "string" || !expected.has(row.qid)) {
      invalidQuestionIds += 1;
      continue;
    }
    counts.set(row.qid, (counts.get(row.qid) ?? 0) + 1);
  }
  const missing = expectedQuestionIds.filter((qid) => !counts.has(qid));
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);

  const expectedQuestionCount = expectedQuestionIds.length;
  if (rows.length !== expectedQuestionCount) {
    failures.push(
      `${system}: ${rows.length}/${expectedQuestionCount} rows from current run identity ${identity.repoSha}`,
    );
  }
  if (invalidQuestionIds > 0) {
    failures.push(`${system}: ${invalidQuestionIds} row(s) have an invalid or unexpected question id`);
  }
  if (missing.length > 0) {
    failures.push(`${system}: missing ${missing.length} expected question row(s)`);
  }
  if (duplicates.length > 0) {
    failures.push(`${system}: duplicate rows for ${duplicates.length} question id(s)`);
  }
  const errorCount = rows.filter((row) => typeof row.error === "string" && row.error.length > 0).length;
  if (errorCount > 0) failures.push(`${system}: ${errorCount} current-run row(s) contain errors`);
  return failures;
}

export function aggregateExitCode(fatalFlags: readonly string[]): 0 | 1 {
  return fatalFlags.length === 0 ? 0 : 1;
}
