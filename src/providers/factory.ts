import type { MemoryProvider } from "../provider.js";
import { FileProvider } from "./file-provider.js";
import { InMemoryProvider } from "./in-memory-provider.js";
import { EnhancedMemoryProvider } from "./enhanced-provider.js";
import { DualLayerMemoryProvider } from "./dual-layer-provider.js";

export type MemoryProviderKind = "in-memory" | "file" | "enhanced" | "dual-layer";

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
  
  if (options.kind === "enhanced") {
    return new EnhancedMemoryProvider();
  }

  if (options.kind === "dual-layer") {
    return new DualLayerMemoryProvider();
  }

  return new InMemoryProvider();
}
