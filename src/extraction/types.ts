import type { MemoryType } from "../types.js";

/** One raw conversation turn handed to an extractor. */
export interface ExtractionTurn {
  role?: string;
  text: string;
  /**
   * When the turn happened. Drives relative-date resolution; absent means
   * unknown, and an unknown date is labelled as such rather than filled in.
   * The offset the timestamp carries is honoured, so send the caller's local
   * offset ("2026-07-28T20:00:00-04:00"), not UTC, or the turn is labelled with
   * its UTC day. See dates.ts.
   */
  at?: string;
}

export interface ExtractionInput {
  turns: ExtractionTurn[];
  /** Reference time for resolving relative dates in turns with no `at`. */
  now: string;
  /** Who "I" refers to. */
  actor?: string;
  /** Optional thread/session hint. */
  context?: string;
}

/**
 * How a fact's text was produced. Only "extracted" text has been through the
 * provenance + grounding gates; the other two are raw turn text stored verbatim,
 * so a consumer must not treat them as verified.
 *
 * - "extracted"   an LLM rewrote the turn and the result passed both gates.
 * - "fallback"    extraction was attempted and failed (call error, unusable
 *                 response); the raw turn is kept so nothing is lost. Ungrounded
 *                 and unverified: alert on it, and never treat it as a distilled
 *                 fact.
 * - "passthrough" no extraction was configured (MEMORY_EXTRACTOR=none). Raw turn
 *                 by design, not a failure.
 */
export type FactOrigin = "extracted" | "fallback" | "passthrough";

export interface ExtractedFact {
  /** Self-contained, dated, resolvable without the source turn. */
  text: string;
  memoryType: MemoryType;
  importance?: number;
  confidence?: number;
  /** Indexes into `ExtractionInput.turns`. Mandatory provenance. */
  sourceTurnIndexes: number[];
  /** Whether `text` was extracted and grounded, or is a raw turn. */
  origin: FactOrigin;
}

export interface Extractor {
  readonly id: string;
  extract(input: ExtractionInput): Promise<ExtractedFact[]>;
}

/** Backends `createExtractor` can build. `none` is the passthrough (zero LLM calls). */
export type ExtractorKind = "none" | "llm";

export interface ExtractorSpec {
  kind: ExtractorKind;
  /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Turns per LLM call. Higher amortizes the prompt; lower keeps attribution sharp. */
  batchSize?: number;
}
