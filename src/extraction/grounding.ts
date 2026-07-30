// Anti-fabrication gate for extracted facts.
//
// An extracted fact is a REWRITE (dates normalized, pronouns resolved), so it can
// never be checked by substring match against the source. What can be checked is
// vocabulary: a faithful rewrite reuses the conversation's content words plus a
// closed set of date/attribution words. A fabricated claim introduces content
// words that appear nowhere in the window it was extracted from.
//
// Three rules make that check hard to game:
// - WINDOW SCOPE. The vocabulary covers only the turns the model was shown for
//   this batch (its extractable turns plus the read-only lookback), not the whole
//   conversation. A claim recombining an entity from turn 2 with a number from
//   turn 40 is therefore ungrounded, which is the point.
// - SET SEMANTICS. Each distinct token counts once, so padding a false claim with
//   repeated in-window words cannot buy room for novel ones.
// - FREE WORDS ARE NEUTRAL. Calendar and attribution words are allowed but score
//   nothing: they leave the ratio entirely, so "user said ... on Monday morning"
//   cannot inflate an invented claim.
//
// This catches whole-cloth invention (the failure that matters: a provider in
// this repo once emitted a benchmark's gold answer as a "memory"). It does NOT
// catch a swapped number, a negated claim, or a recombination built entirely from
// words inside the same window — a stated limitation, not an oversight.

import { tokenize } from "../retrieval/tokenize.js";
import { dateVocabulary } from "./dates.js";
import { sanitizePromptLabel } from "./sanitize.js";
import type { ExtractionInput } from "./types.js";

/** Calendar words a date normalization may legitimately introduce. */
const CALENDAR_WORDS = [
  "january february march april may june july august september october november december",
  "jan feb mar apr jun jul aug sep sept oct nov dec",
  "monday tuesday wednesday thursday friday saturday sunday",
  "mon tue tues wed thu thurs fri sat sun",
  "morning afternoon evening night noon midnight day week weekend month year date time",
  "earlier later before after during since until around approximately",
].join(" ");

/** Attribution words a self-contained rewrite may legitimately introduce. */
const ATTRIBUTION_WORDS =
  "said says told mentioned stated reported noted asked replied shared described explained user assistant speaker person";

/**
 * Tokens that are neither evidence nor invention: allowed in a fact, but they do
 * not count as grounded. They drop out of the ratio on both sides.
 */
const NEUTRAL_TOKENS = new Set([...tokenize(CALENDAR_WORDS), ...tokenize(ATTRIBUTION_WORDS)]);

/** Half-open turn range a fact is allowed to be grounded in. */
export interface VocabularyWindow {
  /** First turn the model was shown (the read-only lookback starts here). */
  start: number;
  /** One past the last turn the model was shown. */
  end: number;
}

export interface GroundingOptions {
  /** Share of a fact's distinct content tokens that must appear in the window. */
  minRatio?: number;
  extraVocabulary?: string[];
}

/**
 * Measured separation on the module tests' faithful rewrites vs fabrications:
 * faithful rewrites score 0.55-1.00, fabrications 0.00-0.17. The threshold sits
 * at 0.5 rather than mid-gap on purpose — a false rejection loses a real memory,
 * and the model's own instructions are the first line of defence.
 */
export const DEFAULT_MIN_GROUNDED_RATIO = 0.5;

/** A fact with less than this much checkable content is not accepted. */
const MIN_CONTENT_TOKENS = 2;

/**
 * Stemmed tokens the model was allowed to see for ONE batch. The window is a
 * required argument: a vocabulary built from every turn in the input grades a
 * fact against text its own batch never saw.
 *
 * Only turns that carry a date contribute date tokens, and `input.now`
 * contributes none: a turn rendered as "date not recorded" must not be able to
 * acquire today's date, because supplying those tokens is exactly the
 * fabrication this gate exists to catch.
 */
export function buildVocabulary(
  input: ExtractionInput,
  window: VocabularyWindow,
  extra: string[] = [],
): Set<string> {
  const parts: string[] = [...extra];
  // Capped: a display name or thread id is untrusted, and every token in one
  // widens what counts as grounded.
  if (input.actor) parts.push(sanitizePromptLabel(input.actor).replace(/[_-]+/g, " "));
  if (input.context) parts.push(sanitizePromptLabel(input.context).replace(/[_-]+/g, " "));

  const start = Math.max(0, Math.trunc(window.start));
  const end = Math.min(input.turns.length, Math.trunc(window.end));
  for (let i = start; i < end; i++) {
    const turn = input.turns[i];
    parts.push(turn.text);
    if (turn.role) parts.push(turn.role);
    if (turn.at) parts.push(...dateVocabulary(turn.at));
  }

  const vocabulary = new Set<string>();
  for (const part of parts) {
    for (const token of tokenize(part)) vocabulary.add(token);
  }
  return vocabulary;
}

export interface GroundingReport {
  ratio: number;
  novel: string[];
  grounded: boolean;
  /** Distinct tokens that carried evidence either way (neutral words excluded). */
  contentTokens: number;
}

export function checkGrounding(
  text: string,
  vocabulary: Set<string>,
  options: GroundingOptions = {},
): GroundingReport {
  const minRatio = options.minRatio ?? DEFAULT_MIN_GROUNDED_RATIO;
  const extra = options.extraVocabulary?.length
    ? new Set(tokenize(options.extraVocabulary.join(" ")))
    : null;

  const novel: string[] = [];
  let hits = 0;
  for (const token of new Set(tokenize(text))) {
    if (NEUTRAL_TOKENS.has(token)) continue;
    if (vocabulary.has(token) || extra?.has(token)) hits += 1;
    else novel.push(token);
  }

  const contentTokens = hits + novel.length;
  // Stopwords and free words only: nothing to verify, and nothing to remember.
  if (contentTokens < MIN_CONTENT_TOKENS) return { ratio: 0, novel, grounded: false, contentTokens };

  const ratio = hits / contentTokens;
  return { ratio, novel, grounded: ratio >= minRatio, contentTokens };
}
