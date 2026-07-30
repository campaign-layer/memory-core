import { LlmExtractor } from "./llm-extractor.js";
import { OpenAiChatClient } from "./llm.js";
import { PassthroughExtractor } from "./passthrough-extractor.js";
import type { Extractor, ExtractorSpec } from "./types.js";

export * from "./types.js";
export * from "./dates.js";
export * from "./grounding.js";
export * from "./llm.js";
export * from "./llm-extractor.js";
export * from "./passthrough-extractor.js";
export * from "./sanitize.js";

/**
 * Builds an extractor from a declarative spec (see config.ts for the env parse).
 *
 * `none` is the default and returns the passthrough: an existing deployment
 * keeps today's write path, byte for byte, until MEMORY_EXTRACTOR is set. Both
 * kinds are cheap to construct — the llm kind only reads a key, it never calls
 * out at construction time.
 */
export function createExtractor(spec: ExtractorSpec): Extractor {
  switch (spec.kind) {
    case "none":
      return new PassthroughExtractor();
    case "llm":
      return new LlmExtractor({
        client: new OpenAiChatClient({
          baseUrl: spec.baseUrl,
          apiKey: spec.apiKey,
          model: spec.model,
        }),
        batchSize: spec.batchSize,
      });
    default: {
      const exhaustive: never = spec.kind;
      throw new Error(`unknown extractor kind: ${String(exhaustive)}`);
    }
  }
}
