/**
 * Mode B: QA accuracy with an LLM judge, on top of Mode A's retrieval.
 *
 *   npx tsx modeB.ts --conditions=k10,k30,oracle [--limit=10] [--oracle-n=150] [--concurrency=8] [--tag=full]
 *
 * Conditions:
 *   k10 / k30 : context = the retrieval system's top-10 / top-30 turns (Mode A ranking).
 *               The default retrieval system is `memory-core`, which is BM25-ONLY.
 *   oracle    : context = the gold turns only, on a stratified subsample. This is the
 *               answering upper bound; oracle-minus-k30 is retrieval failure and
 *               100%-minus-oracle is reader/judge failure. Without it a low score
 *               cannot be attributed.
 *
 * Two scoring populations, never mixed into one headline number:
 *   answerable (nGold > 0)  - graded strictly; "I don't know" is INCORRECT.
 *   abstention (nGold == 0) - LongMemEval's *_abs questions, whose gold answer states
 *                             that the info was never provided. Correctly declining is
 *                             CORRECT and confidently answering is INCORRECT, so these
 *                             need the opposite rubric and are reported separately.
 *
 * Resumable: one JSONL line per (condition, question); existing lines are skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { buildCorpus, loadQuestion, type LmeQuestion } from "./dataset.js";
import {
  aggregateExitCode, datasetShaFromManifest, modeBRowMatchesRun,
  parseNonNegativeInteger, requireNonEmptyQuestionSelection, rowMatchesRun,
  selectCompleteRunRows, systemRunFailures,
  type ModeARunIdentity, type ModeBRunIdentity,
} from "./integrity.js";
import {
  DATASET_S, MANIFEST, MODE_B_DIR, requireModeA, requirePrepared, RESULTS_DIR,
} from "./paths.js";
import { captureProvenance } from "./provenance.js";
import { chat, loadApiKey, pool } from "./openrouter.js";
import { retrievalConfigLabel } from "./systems.js";

const MODEL = "deepseek/deepseek-v4-flash";
/** OpenRouter list price at run time, used only if the API omits usage.cost. */
const PRICE_IN_PER_TOKEN = 0.14 / 1e6;
const PRICE_OUT_PER_TOKEN = 0.28 / 1e6;
/**
 * Mode B reads Mode A's ranking for this system. "memory-core" is the BM25-only
 * configuration (embedder=none) -- the published QA accuracy numbers are therefore
 * BM25-only retrieval, NOT hybrid. Override with --retrieval-system= to score another.
 */
const DEFAULT_RETRIEVAL_SYSTEM = "memory-core";
/** Defensive cap; a single pathological turn should not dominate the prompt. */
const MAX_MEMORY_CHARS = 8000;
/** Generous: some upstreams for this model spend most of the budget on reasoning. */
const ANSWER_MAX_TOKENS = 900;
const JUDGE_MAX_TOKENS = 400;

const TYPE_ORDER = [
  "temporal-reasoning", "multi-session", "knowledge-update",
  "single-session-user", "single-session-assistant", "single-session-preference",
];

const ANSWERER_SYSTEM = [
  "You answer questions about a user using ONLY the numbered memories provided.",
  "Each memory is one turn of a past conversation, tagged with the date of that conversation.",
  "Rules:",
  "- Use only the memories. Do not use outside knowledge and do not guess.",
  "- If the memories do not contain the answer, reply exactly: I don't know",
  "- Otherwise answer with the shortest possible span: a phrase, name, number, list, or date.",
  "- No explanation, no preamble, no restating the question.",
].join("\n");

const JUDGE_SYSTEM = [
  "You are a strict grader for short-answer question answering.",
  "You are given a QUESTION, the GOLD answer, and a CANDIDATE answer.",
  "Mark CORRECT only if the candidate conveys the same fact as the gold answer.",
  "Accept: different wording, paraphrase, different but equivalent date/number formatting,",
  "extra detail that does not contradict the gold, and a superset that clearly contains the gold fact.",
  "Mark INCORRECT if the candidate: says it does not know, refuses, is empty, is hedged or",
  "non-committal, contradicts the gold, names a different entity, or omits the key fact the",
  "question asks for. A vague answer that would not satisfy the question is INCORRECT.",
  "Reply with exactly two lines and nothing else:",
  "VERDICT: CORRECT",
  "REASON: <one short line>",
].join("\n");

/**
 * single-session-preference is NOT a short-answer task. Its question is an open
 * request ("suggest some accessories for my setup") and its gold is a rubric
 * describing the preference a good answer must reflect. Scoring it with the
 * short-span prompt above makes the reader answer "I don't know" every time and
 * reports 0% for a prompt reason, not a memory reason. Branching on question_type
 * leaks nothing - it is dataset metadata, not the answer.
 */
const PREF_ANSWERER_SYSTEM = [
  "You are responding to a user request, using ONLY the numbered memories as background",
  "about that user. Each memory is one turn of a past conversation, tagged with its date.",
  "Give a short, concrete, personalised response (1-3 sentences) that reflects what the",
  "memories tell you about this user's situation, equipment, tastes and constraints, and",
  "name the specific details from the memories that make it personalised.",
  "If the memories contain nothing relevant to the request, reply exactly: I don't know",
].join("\n");

const PREF_JUDGE_SYSTEM = [
  "You are grading whether a RESPONSE is correctly personalised to a user.",
  "GOLD describes the preference the response should reflect, and what it should avoid.",
  "Mark CORRECT if the candidate reflects the substance of that preference - the key entities",
  "or constraints named in GOLD (the right brand, device, ingredients, or prior purchase) -",
  "even if it is shorter, differently worded, or adds extra suggestions.",
  "Mark INCORRECT if the candidate ignores or contradicts the preference, recommends what GOLD",
  "says the user would not want, is a refusal or \"I don't know\", or is empty.",
  "Reply with exactly two lines and nothing else:",
  "VERDICT: CORRECT",
  "REASON: <one short line>",
].join("\n");

/** Rubric for the *_abs questions: the right behaviour is to decline. */
const ABSTAIN_JUDGE_SYSTEM = [
  "You are grading whether a system correctly RECOGNISED THAT IT CANNOT ANSWER.",
  "The GOLD answer states that the needed information was never provided by the user.",
  "Mark CORRECT if the candidate declines: says it does not know, says the information is",
  "not available or not mentioned, or asks for the missing information.",
  "Mark INCORRECT if the candidate confidently supplies a specific answer to the question,",
  "because that is a fabrication - the information does not exist in the conversations.",
  "Reply with exactly two lines and nothing else:",
  "VERDICT: CORRECT",
  "REASON: <one short line>",
].join("\n");

interface ModeARow {
  qid: string; type: string; nGold: number; ranking: Array<[string, number]>;
  repoSha?: string; repoRoot?: string; datasetSha?: string; seed?: number; error?: string;
}

const USAGE = [
  "LongMemEval Mode B: QA accuracy with an LLM reader and an LLM judge.",
  "",
  "  npx tsx modeB.ts [--conditions=k10,k30,oracle] [options]",
  "",
  "  --conditions=... k10 | k30 | oracle (comma separated, default all three)",
  "  --tag=NAME       report name -> out/modeB-<tag>.{json,md} (default full)",
  "  --oracle-n=N     size of the stratified oracle subsample (default 150)",
  "  --concurrency=N  in-flight OpenRouter requests (default 8)",
  "  --limit=N        only the first N questions (smoke tests)",
  "  --seed=N         Mode A random-control seed / cache identity (default 1234)",
  "  --retrieval-system=NAME  which Mode A ranking to read (default memory-core,",
  "                           which is the BM25-only configuration)",
  "",
  "Needs OPENROUTER_API_KEY and Mode A results. COSTS MONEY (~$0.86 for the full run).",
  "Prefer ./run-modeB.sh.",
].join("\n");

function arg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  if (fallback !== undefined) return fallback;
  console.error(`${USAGE}\n\nerror: missing --${name}`);
  process.exit(2);
}

function readModeA(
  system: string,
  expectedRun: ModeARunIdentity,
): { rows: Map<string, ModeARow>; staleRowsIgnored: number } {
  const dir = requireModeA(system);
  const map = new Map<string, ModeARow>();
  let staleRowsIgnored = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as ModeARow;
        if (!rowMatchesRun(row, expectedRun)) {
          staleRowsIgnored += 1;
          continue;
        }
        const previous = map.get(row.qid);
        if (!previous || (previous.error && !row.error)) map.set(row.qid, row);
      } catch { /* torn line */ }
    }
  }
  if (map.size === 0) throw new Error(`Mode A results for ${system} are empty`);
  return { rows: map, staleRowsIgnored };
}

function readModeB(
  file: string,
  expectedRun: ModeBRunIdentity,
): { rows: any[]; staleRowsIgnored: number } {
  if (!fs.existsSync(file)) return { rows: [], staleRowsIgnored: 0 };
  const byQid = new Map<string, any>();
  let staleRowsIgnored = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!modeBRowMatchesRun(row, expectedRun)) {
        staleRowsIgnored += 1;
        continue;
      }
      const previous = byQid.get(row.qid);
      if (!previous || (previous.error && !row.error)) byQid.set(row.qid, row);
    } catch { /* torn line */ }
  }
  return { rows: [...byQid.values()], staleRowsIgnored };
}

let truncations = 0;

function renderContext(ids: string[], corpus: ReturnType<typeof buildCorpus>): string {
  const out: string[] = [];
  ids.forEach((id, i) => {
    const t = corpus.byId.get(id);
    if (!t) return;
    let content = t.content;
    if (content.length > MAX_MEMORY_CHARS) { content = `${content.slice(0, MAX_MEMORY_CHARS)} ...[truncated]`; truncations++; }
    out.push(`[${i + 1}] ${t.dateRaw} | ${t.role}: ${content}`);
  });
  return out.join("\n");
}

function answererUser(corpus: ReturnType<typeof buildCorpus>, context: string): string {
  return [
    `Today's date: ${corpus.questionDate}`, "",
    "Memories:", context || "(none)", "",
    `Question: ${corpus.question}`, "Answer:",
  ].join("\n");
}

function judgeUser(question: string, gold: string, candidate: string): string {
  return [`QUESTION: ${question}`, `GOLD: ${gold}`, `CANDIDATE: ${candidate}`].join("\n");
}

/** Stratified, deterministic subsample. */
function stratifiedSubsample(qids: string[], typeOf: Map<string, string>, n: number): string[] {
  const byType = new Map<string, string[]>();
  for (const q of qids) {
    const t = typeOf.get(q) ?? "unknown";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(q);
  }
  const picked: string[] = [];
  for (const [, list] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = list.slice().sort();
    const quota = Math.max(1, Math.round((n * sorted.length) / qids.length));
    const step = Math.max(1, Math.floor(sorted.length / quota));
    for (let i = 0, taken = 0; i < sorted.length && taken < quota; i += step, taken++) picked.push(sorted[i]!);
  }
  return picked.sort();
}

function parseVerdict(text: string): { correct: boolean; reason: string; parsed: boolean } {
  const v = /VERDICT:\s*(CORRECT|INCORRECT)/i.exec(text);
  const r = /REASON:\s*(.+)/i.exec(text);
  if (!v) {
    const loose = /\b(INCORRECT|CORRECT)\b/i.exec(text);
    return { correct: !!loose && loose[1]!.toUpperCase() === "CORRECT", reason: text.slice(0, 200), parsed: false };
  }
  return { correct: v[1]!.toUpperCase() === "CORRECT", reason: r?.[1]?.trim() ?? "", parsed: true };
}

const IDK = /^\s*(i don'?t know|i do not know|unknown|not enough information|cannot determine)\b/i;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  requirePrepared();
  const conditions = arg("conditions", "k10,k30,oracle").split(",").map((x) => x.trim()).filter(Boolean);
  if (conditions.length === 0 || new Set(conditions).size !== conditions.length) {
    throw new Error("--conditions must contain one or more unique condition names");
  }
  const unknownConditions = conditions.filter((condition) => !["k10", "k30", "oracle"].includes(condition));
  if (unknownConditions.length > 0) throw new Error(`unknown condition(s): ${unknownConditions.join(", ")}`);
  const limit = parseNonNegativeInteger(arg("limit", "0"), "limit");
  const oracleN = parseNonNegativeInteger(arg("oracle-n", "150"), "oracle-n");
  const concurrency = parseNonNegativeInteger(arg("concurrency", "8"), "concurrency");
  const seed = parseNonNegativeInteger(arg("seed", "1234"), "seed");
  if (oracleN === 0) throw new Error("--oracle-n must be greater than zero");
  if (concurrency === 0) throw new Error("--concurrency must be greater than zero");
  const tag = arg("tag", "full");
  const RETRIEVAL_SYSTEM = arg("retrieval-system", DEFAULT_RETRIEVAL_SYSTEM);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const datasetSha = datasetShaFromManifest(manifest);
  const provenance = captureProvenance(DATASET_S, datasetSha);
  if (provenance.repo.dirty) {
    throw new Error("LongMemEval Mode B requires a clean worktree, including untracked source and configuration files");
  }
  const modeARun: ModeARunIdentity = {
    repoSha: provenance.repo.sha,
    repoRoot: provenance.repo.root,
    datasetSha,
    seed,
  };
  const loadedModeA = readModeA(RETRIEVAL_SYSTEM, modeARun);
  const modeA = loadedModeA.rows;
  const manifestQuestionIds: string[] = manifest.perQuestion.map((question: any) => question.questionId);
  const modeAInput = selectCompleteRunRows(
    `Mode A ${RETRIEVAL_SYSTEM}`,
    [...modeA.values()],
    manifestQuestionIds,
    limit,
    modeARun,
  );
  if (modeAInput.failures.length > 0) {
    throw new Error(
      `Mode A input is incomplete or invalid; rerun Mode A before spending on Mode B:\n` +
        modeAInput.failures.join("\n"),
    );
  }
  const apiKey = loadApiKey();
  console.log(`retrieval system: ${RETRIEVAL_SYSTEM} — ${retrievalConfigLabel(RETRIEVAL_SYSTEM)}`);

  const qids = modeAInput.questionIds;
  const typeOf = new Map([...modeA.values()].map((r) => [r.qid, r.type]));
  const nGoldOf = new Map([...modeA.values()].map((r) => [r.qid, r.nGold]));
  const isAbstention = (qid: string) => (nGoldOf.get(qid) ?? 0) === 0;

  fs.mkdirSync(MODE_B_DIR, { recursive: true });
  const t0 = Date.now();
  const providerCounts: Record<string, number> = {};
  const targetsByCondition = new Map<string, string[]>();
  const modeBRuns = new Map<string, ModeBRunIdentity>();

  for (const condition of conditions) {
    // Oracle feeds gold turns, so it is only defined for answerable questions.
    const answerable = qids.filter((q) => !isAbstention(q));
    const target = condition === "oracle"
      ? (limit > 0 ? answerable : stratifiedSubsample(answerable, typeOf, oracleN))
      : qids;
    requireNonEmptyQuestionSelection(target, `Mode B ${condition}`);
    targetsByCondition.set(condition, target);
    const modeBRun: ModeBRunIdentity = {
      ...modeARun,
      retrievalSystem: RETRIEVAL_SYSTEM,
      model: MODEL,
      condition,
    };
    modeBRuns.set(condition, modeBRun);

    const out = path.join(MODE_B_DIR, `${condition}.jsonl`);
    const cached = readModeB(out, modeBRun);
    const done = new Set(cached.rows.filter((r) => !r.error).map((r) => r.qid));
    const todo = target.filter((q) => !done.has(q));
    console.log(
      `[${condition}] target=${target.length} todo=${todo.length} ` +
        `(resumed ${done.size}, ignored ${cached.staleRowsIgnored} stale rows)`,
    );

    let completed = 0;
    await pool(todo, concurrency, async (qid) => {
      const item: LmeQuestion = loadQuestion(qid);
      const corpus = buildCorpus(item);
      const row = modeA.get(qid)!;
      const abstain = isAbstention(qid);

      let ids: string[];
      if (condition === "oracle") ids = corpus.goldIds;
      else if (condition === "k10") ids = row.ranking.slice(0, 10).map((x) => x[0]);
      else if (condition === "k30") ids = row.ranking.slice(0, 30).map((x) => x[0]);
      else throw new Error(`unknown condition ${condition}`);

      // Abstention wins over type: with no gold turns there is nothing to personalise.
      const rubric = abstain ? "abstention" : corpus.questionType === "single-session-preference" ? "preference" : "factual";

      const record: any = {
        qid, type: corpus.questionType, condition, population: abstain ? "abstention" : "answerable",
        rubric, nContext: ids.length, nGold: corpus.goldIds.length, gold: corpus.answer,
        repoSha: modeBRun.repoSha,
        repoRoot: modeBRun.repoRoot,
        datasetSha: modeBRun.datasetSha,
        seed: modeBRun.seed,
        retrievalSystem: modeBRun.retrievalSystem,
        model: modeBRun.model,
      };

      try {
        const context = renderContext(ids, corpus);
        record.contextChars = context.length;

        const ans = await chat(apiKey, {
          model: MODEL,
          system: rubric === "preference" ? PREF_ANSWERER_SYSTEM : ANSWERER_SYSTEM,
          user: answererUser(corpus, context),
          maxTokens: ANSWER_MAX_TOKENS,
        });
        record.candidate = ans.text.trim();
        record.abstained = IDK.test(record.candidate);
        record.answerUsage = ans.usage;
        record.answerProvider = ans.provider;
        record.answerFinish = ans.finishReason;
        record.answerFromReasoning = ans.fromReasoning;

        const jud = await chat(apiKey, {
          model: MODEL,
          system: rubric === "abstention" ? ABSTAIN_JUDGE_SYSTEM : rubric === "preference" ? PREF_JUDGE_SYSTEM : JUDGE_SYSTEM,
          user: judgeUser(corpus.question, corpus.answer, record.candidate),
          maxTokens: JUDGE_MAX_TOKENS,
        });
        const verdict = parseVerdict(jud.text);
        record.correct = verdict.correct;
        record.judgeReason = verdict.reason;
        record.judgeFormatOk = verdict.parsed;
        record.judgeUsage = jud.usage;
        record.judgeProvider = jud.provider;
        record.judgeRaw = jud.text.trim().slice(0, 400);
      } catch (err: any) {
        record.error = String(err?.message ?? err).slice(0, 500);
      }

      fs.appendFileSync(out, `${JSON.stringify(record)}\n`);
      if (++completed % 25 === 0) console.log(`[${condition}] ${completed}/${todo.length}`);
    });
    console.log(`[${condition}] done`);
  }

  // ---------------- report ----------------
  const report: any = {
    mode: "B-qa-with-llm-judge",
    tag,
    provenance,
    model: {
      answerer: MODEL, judge: MODEL, temperature: 0,
      answerMaxTokens: ANSWER_MAX_TOKENS, judgeMaxTokens: JUDGE_MAX_TOKENS,
      reasoning: "NOT disabled. This is a reasoning model and a small fraction of calls return content=null; " +
        "those are retried (which re-rolls OpenRouter's upstream) and, if content is still empty, the answer is " +
        "recovered from the reasoning trace. Empty content is never scored as a wrong answer. " +
        "See conditions[].answersRecoveredFromReasoning and conditions[].errors.",
    },
    // Mode B executes no provider code; its provenance is the provenance of the
    // Mode A rankings it consumes, taken from those rows' own run-time stamps.
    retrievalProvenance: {
      system: RETRIEVAL_SYSTEM,
      retrievalConfig: retrievalConfigLabel(RETRIEVAL_SYSTEM),
      repoShas: [...new Set([...modeA.values()].map((r) => r.repoSha ?? "unstamped"))].sort(),
      repoRoots: [...new Set([...modeA.values()].map((r) => r.repoRoot ?? "unknown"))].sort(),
      datasetShas: [...new Set([...modeA.values()].map((r) => r.datasetSha ?? "unstamped"))].sort(),
      seeds: [...new Set([...modeA.values()].map((r) => r.seed ?? "unstamped"))],
      staleRowsIgnored: loadedModeA.staleRowsIgnored,
    },
    protocol: {
      retrievalFrom: `Mode A ranking of system "${RETRIEVAL_SYSTEM}" (${retrievalConfigLabel(RETRIEVAL_SYSTEM)})`,
      contextFormat: "[i] <session date> | <role>: <content>",
      questionDateGivenToReader: true,
      abstentionAllowed: "answerer may reply \"I don't know\"",
      judgeAnswerable: "binary CORRECT/INCORRECT, strict; \"I don't know\" is INCORRECT",
      judgePreference: "single-session-preference is a personalisation task, not short-answer: its gold is a rubric describing the preference a good response must reflect, so it gets its own answerer prompt and its own judge rubric. Prompts branch on question_type only, never on the answer.",
      judgeAbstention: "separate rubric for the 21 *_abs questions: correctly declining is CORRECT, fabricating an answer is INCORRECT",
      judgeSeesContext: false,
      oracleSubsample: `answerable only, stratified by question_type, n≈${oracleN}, deterministic`,
      maxMemoryChars: MAX_MEMORY_CHARS,
      seed,
      memoryTruncationsThisRun: truncations,
      providerRouting: "OpenRouter default routing; the serving upstream varies per call and is recorded per row",
    },
    conditions: {} as Record<string, any>,
  };

  const lines: string[] = [];
  lines.push("# LongMemEval Mode B (QA + LLM judge) - memory-core internal harness");
  lines.push("");
  lines.push(`Answerer & judge: ${MODEL} (temperature 0).`);
  lines.push(`Retrieval: ${RETRIEVAL_SYSTEM} — ${retrievalConfigLabel(RETRIEVAL_SYSTEM)}.`);
  lines.push(`Repo ${report.provenance.repo.sha.slice(0, 7)}, dataset sha256 ${report.provenance.dataset.sha256.slice(0, 16)}...`);
  lines.push("");

  let grandCost = 0, grandIn = 0, grandOut = 0;
  const ansTable = ["| condition | n | correct | accuracy | said IDK | errors |", "|---|---|---|---|---|---|"];
  const absTable = ["| condition | n | correctly declined | accuracy |", "|---|---|---|---|"];
  const perTypeAcc: Record<string, Record<string, string>> = {};
  const fatalRunFlags: string[] = [];
  const staleModeBRowsIgnored: Record<string, number> = {};

  for (const condition of conditions) {
    const target = targetsByCondition.get(condition)!;
    const targetSet = new Set(target);
    const loaded = readModeB(path.join(MODE_B_DIR, `${condition}.jsonl`), modeBRuns.get(condition)!);
    const rows = loaded.rows.filter((r) => targetSet.has(r.qid));
    staleModeBRowsIgnored[condition] = loaded.staleRowsIgnored;
    fatalRunFlags.push(...systemRunFailures(`Mode B ${condition}`, rows, target, modeARun));
    if (rows.length === 0) continue;

    for (const r of rows) {
      for (const p of [r.answerProvider, r.judgeProvider]) if (p) providerCounts[p] = (providerCounts[p] ?? 0) + 1;
    }

    const graded = rows.filter((r) => !r.error);
    const ansRows = graded.filter((r) => r.population === "answerable");
    const absRows = graded.filter((r) => r.population === "abstention");

    const nCorrect = ansRows.filter((r) => r.correct).length;
    const acc = ansRows.length ? nCorrect / ansRows.length : 0;
    const absCorrect = absRows.filter((r) => r.correct).length;

    const tokIn = rows.reduce((a, r) => a + (r.answerUsage?.promptTokens ?? 0) + (r.judgeUsage?.promptTokens ?? 0), 0);
    const tokOut = rows.reduce((a, r) => a + (r.answerUsage?.completionTokens ?? 0) + (r.judgeUsage?.completionTokens ?? 0), 0);
    const reported = rows.reduce((a, r) => a + (r.answerUsage?.costUsd ?? 0) + (r.judgeUsage?.costUsd ?? 0), 0);
    const cost = reported > 0 ? reported : tokIn * PRICE_IN_PER_TOKEN + tokOut * PRICE_OUT_PER_TOKEN;
    grandCost += cost; grandIn += tokIn; grandOut += tokOut;

    const perType: Record<string, any> = {};
    for (const t of TYPE_ORDER) {
      const sub = ansRows.filter((r) => r.type === t);
      if (sub.length === 0) continue;
      const c = sub.filter((r) => r.correct).length;
      perType[t] = { n: sub.length, correct: c, accuracy: c / sub.length };
      perTypeAcc[t] = perTypeAcc[t] ?? {};
      perTypeAcc[t]![condition] = `${(c / sub.length).toFixed(3)} (${c}/${sub.length})`;
    }

    report.conditions[condition] = {
      rows: rows.length, errors: rows.length - graded.length,
      answerable: {
        n: ansRows.length, correct: nCorrect, accuracy: acc,
        saidIdk: ansRows.filter((r) => r.abstained).length,
        perType,
      },
      abstention: {
        n: absRows.length, correct: absCorrect,
        accuracy: absRows.length ? absCorrect / absRows.length : null,
      },
      judgeFormatViolations: graded.filter((r) => r.judgeFormatOk === false).length,
      answersRecoveredFromReasoning: graded.filter((r) => r.answerFromReasoning).length,
      meanContextChars: rows.length ? rows.reduce((a, r) => a + (r.contextChars ?? 0), 0) / rows.length : 0,
      tokens: { prompt: tokIn, completion: tokOut },
      costUsd: cost,
      costSource: reported > 0 ? "openrouter usage.cost" : "list price fallback",
      errorSamples: rows.filter((r) => r.error).slice(0, 3).map((r) => ({ qid: r.qid, error: r.error })),
    };

    ansTable.push(`| ${condition} | ${ansRows.length} | ${nCorrect} | ${acc.toFixed(4)} | ${report.conditions[condition].answerable.saidIdk} | ${rows.length - graded.length} |`);
    if (absRows.length) absTable.push(`| ${condition} | ${absRows.length} | ${absCorrect} | ${(absCorrect / absRows.length).toFixed(4)} |`);
  }

  const typeTable = [`| question_type | ${conditions.join(" | ")} |`, `|---|${conditions.map(() => "---").join("|")}|`];
  for (const t of TYPE_ORDER) {
    if (!perTypeAcc[t]) continue;
    typeTable.push(`| ${t} | ${conditions.map((c) => perTypeAcc[t]![c] ?? "-").join(" | ")} |`);
  }

  report.totals = { promptTokens: grandIn, completionTokens: grandOut, costUsd: grandCost, wallClockSec: (Date.now() - t0) / 1000 };
  report.providerCounts = providerCounts;
  report.integrity = {
    ok: fatalRunFlags.length === 0,
    fatalRunFlags,
    staleModeBRowsIgnored,
    cacheIdentity: { ...modeARun, retrievalSystem: RETRIEVAL_SYSTEM, model: MODEL },
  };

  lines.push("## Accuracy, ANSWERABLE questions (strict judge)");
  lines.push("");
  lines.push(...ansTable);
  lines.push("");
  lines.push("## Accuracy by question_type (answerable only)");
  lines.push("");
  lines.push(...typeTable);
  lines.push("");
  lines.push("## Abstention subset (LongMemEval *_abs questions, gold = \"information was never provided\")");
  lines.push("");
  lines.push("Scored with the opposite rubric: declining is CORRECT, fabricating an answer is INCORRECT.");
  lines.push("Reported separately and never folded into the headline accuracy.");
  lines.push("");
  lines.push(...absTable);
  lines.push("");
  lines.push("## Cost");
  lines.push("");
  lines.push(`prompt tokens ${grandIn.toLocaleString()}, completion tokens ${grandOut.toLocaleString()}, cost $${grandCost.toFixed(4)}`);
  lines.push("");
  lines.push("## Honesty note");
  lines.push("");
  lines.push("OUR harness, OUR reader model, on the public LongMemEval_S dataset. Not comparable to");
  lines.push("published LongMemEval numbers: different retrieval granularity, different reader, different");
  lines.push("judge, different prompt. The oracle row is the answering ceiling for this reader+judge;");
  lines.push("oracle-minus-k30 is retrieval failure, and 100%-minus-oracle is reader/judge failure.");

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `modeB-${tag}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, `modeB-${tag}.md`), `${lines.join("\n")}\n`);
  console.log(`\n${lines.join("\n")}`);
  console.log(`\nwrote ${path.join(RESULTS_DIR, `modeB-${tag}.json`)}`);
  console.log(`Mode B wall clock: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exitCode = aggregateExitCode(fatalRunFlags);
}

main().catch((err) => { console.error(err); process.exit(1); });
