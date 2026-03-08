import type { MemoryProvider } from "../provider.js";
import { FileProvider } from "./file-provider.js";
import { InMemoryProvider } from "./in-memory-provider.js";

export type MemoryProviderKind = "in-memory" | "file";

export interface ProviderFactoryOptions {
  kind: MemoryProviderKind;
  filePath?: string;
}

export function createMemoryProvider(options: ProviderFactoryOptions): MemoryProvider {
  if (options.kind === "file") {
    if (!options.filePath) {
      throw new Error("filePath is required when MEMORY_PROVIDER=file");
    }
    return new FileProvider(options.filePath);
  }

  return new InMemoryProvider();
}
