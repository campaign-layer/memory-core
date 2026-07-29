import type { MemoryProvider } from "../provider.js";
import { FileProvider } from "./file-provider.js";
import { InMemoryProvider } from "./in-memory-provider.js";
import { EnhancedMemoryProvider } from "./enhanced-provider.js";
import { DualLayerMemoryProvider } from "./dual-layer-provider.js";
import { PostgresMemoryProvider, type EmbeddingProviderLike } from "./postgres-provider.js";
import { createEmbedder, type EmbedderSpec } from "../retrieval/embedder.js";

export type MemoryProviderKind = "in-memory" | "file" | "enhanced" | "dual-layer" | "postgres";

export interface ProviderFactoryOptions {
  kind: MemoryProviderKind;
  filePath?: string;
  postgresUrl?: string;
  /** A ready instance. Takes precedence over `embedderSpec`. */
  embedder?: EmbeddingProviderLike | null;
  /** Declarative selection, normally straight from config. */
  embedderSpec?: EmbedderSpec;
  embeddingModel?: string;
  autoMigrate?: boolean;
  /** RRF fusion constant for hybrid search. Lower makes rank order matter more. */
  rrfK?: number;
}

/**
 * An explicit instance wins; otherwise build from the spec. A missing spec means
 * `none`, so an existing deployment keeps BM25-only ranking until it opts in.
 */
function resolveEmbedder(options: ProviderFactoryOptions): EmbeddingProviderLike | null {
  if (options.embedder !== undefined) return options.embedder;
  if (!options.embedderSpec) return null;
  return createEmbedder(options.embedderSpec);
}

export function createMemoryProvider(options: ProviderFactoryOptions): MemoryProvider {
  const embedder = resolveEmbedder(options);

  if (options.kind === "postgres") {
    return new PostgresMemoryProvider({
      connectionString: options.postgresUrl,
      embedder,
      embeddingModel: options.embeddingModel ?? options.embedderSpec?.model,
      autoMigrate: options.autoMigrate ?? false,
    });
  }

  if (options.kind === "file") {
    if (!options.filePath) {
      throw new Error("filePath is required when MEMORY_PROVIDER=file");
    }
    return new FileProvider(options.filePath, { embedder, rrfK: options.rrfK });
  }

  if (options.kind === "enhanced") {
    return new EnhancedMemoryProvider();
  }

  if (options.kind === "dual-layer") {
    return new DualLayerMemoryProvider();
  }

  return new InMemoryProvider({ embedder, rrfK: options.rrfK });
}
