import type { MemoryProvider } from "../provider.js";
import { FileProvider } from "./file-provider.js";
import { InMemoryProvider } from "./in-memory-provider.js";
import { EnhancedMemoryProvider } from "./enhanced-provider.js";
import { DualLayerMemoryProvider } from "./dual-layer-provider.js";
import { PostgresMemoryProvider, type EmbeddingProviderLike } from "./postgres-provider.js";

export type MemoryProviderKind = "in-memory" | "file" | "enhanced" | "dual-layer" | "postgres";

export interface ProviderFactoryOptions {
  kind: MemoryProviderKind;
  filePath?: string;
  postgresUrl?: string;
  embedder?: EmbeddingProviderLike | null;
  embeddingModel?: string;
  autoMigrate?: boolean;
}

export function createMemoryProvider(options: ProviderFactoryOptions): MemoryProvider {
  if (options.kind === "postgres") {
    return new PostgresMemoryProvider({
      connectionString: options.postgresUrl,
      embedder: options.embedder ?? null,
      embeddingModel: options.embeddingModel,
      autoMigrate: options.autoMigrate ?? false,
    });
  }

  if (options.kind === "file") {
    if (!options.filePath) {
      throw new Error("filePath is required when MEMORY_PROVIDER=file");
    }
    return new FileProvider(options.filePath);
  }
  
  if (options.kind === "enhanced") {
    return new EnhancedMemoryProvider();
  }

  if (options.kind === "dual-layer") {
    return new DualLayerMemoryProvider();
  }

  return new InMemoryProvider();
}
