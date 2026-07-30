import type { ExtractedFact, ExtractionInput, Extractor } from "./types.js";

export const PASSTHROUGH_EXTRACTOR_ID = "passthrough";

/**
 * The default. Every turn becomes one fact with its text unchanged, so the write
 * path behaves exactly as it did before extraction existed: zero LLM calls, zero
 * cost, zero new failure modes. `MEMORY_EXTRACTOR=none` selects this, and
 * service.ingest() stores a fact whose text equals its single source turn as the
 * original observation, which is what makes the default bit-identical.
 */
export class PassthroughExtractor implements Extractor {
  readonly id = PASSTHROUGH_EXTRACTOR_ID;

  async extract(input: ExtractionInput): Promise<ExtractedFact[]> {
    return input.turns.map((turn, index) => ({
      text: turn.text,
      memoryType: "fact" as const,
      sourceTurnIndexes: [index],
      // Raw turn by configuration, not by failure. Never grounded.
      origin: "passthrough" as const,
    }));
  }
}
