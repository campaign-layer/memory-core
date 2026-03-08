import type { MemoryProvider } from "./provider.js";
import { createMemoryCoreApp } from "./http.js";
import { loadConfig, type MemoryCoreConfig } from "./config.js";
import { createMemoryProvider } from "./providers/factory.js";
import { MemoryCoreService } from "./service.js";

export * from "./types.js";
export * from "./provider.js";
export * from "./service.js";
export * from "./http.js";
export * from "./client.js";
export * from "./config.js";
export * from "./providers/factory.js";
export * from "./providers/in-memory-provider.js";
export * from "./providers/file-provider.js";

interface CreateMemoryCoreOptions {
  provider?: MemoryProvider;
  config?: MemoryCoreConfig;
}

export function createMemoryCoreFromConfig(config: MemoryCoreConfig) {
  const provider = createMemoryProvider({
    kind: config.providerKind,
    filePath: config.filePath,
  });
  const service = new MemoryCoreService(provider);
  const app = createMemoryCoreApp(service, {
    apiKeys: config.apiKeys,
    rateLimitPerMin: config.rateLimitPerMin,
  });
  return { provider, service, app, config };
}

export function createDefaultMemoryCore(options: CreateMemoryCoreOptions = {}) {
  const config = options.config || loadConfig();
  const provider = options.provider || createMemoryProvider({
    kind: config.providerKind,
    filePath: config.filePath,
  });
  const service = new MemoryCoreService(provider);
  const app = createMemoryCoreApp(service, {
    apiKeys: config.apiKeys,
    rateLimitPerMin: config.rateLimitPerMin,
  });
  return { provider, service, app, config };
}
