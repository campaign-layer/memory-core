import type { MemoryProvider } from "./provider.js";
import { createMemoryCoreApp } from "./http.js";
import { loadConfig, type MemoryCoreConfig } from "./config.js";
import { createExtractor } from "./extraction/index.js";
import { createMemoryProvider } from "./providers/factory.js";
import { MemoryCoreService } from "./service.js";
import { createReranker } from "./retrieval/rerank.js";

export * from "./types.js";
export * from "./access.js";
export * from "./extraction/index.js";
export * from "./provider.js";
export * from "./service.js";
export * from "./http.js";
export * from "./client.js";
export * from "./config.js";
export * from "./providers/factory.js";
export * from "./providers/in-memory-provider.js";
export * from "./providers/file-provider.js";
export * from "./providers/enhanced-provider.js";
export * from "./providers/dual-layer-provider.js";
export * from "./providers/postgres-provider.js";
export * from "./retrieval/index.js";
export * from "./integrations/index.js";

interface CreateMemoryCoreOptions {
  provider?: MemoryProvider;
  config?: MemoryCoreConfig;
}

export function createMemoryCoreFromConfig(config: MemoryCoreConfig) {
  const provider = createMemoryProvider({
    kind: config.providerKind,
    filePath: config.filePath,
    postgresUrl: config.postgresUrl,
    autoMigrate: config.postgresAutoMigrate,
    embeddingModel: config.embeddingModel,
    embedderSpec: config.embedder,
  });
  const service = new MemoryCoreService(provider, {
    extractor: createExtractor(config.extractor),
    reranker: createReranker(config.reranker ?? { kind: "none" }),
    rerankerMinScore: config.rerankerMinScore,
  });
  const app = createMemoryCoreApp(service, {
    apiKeys: config.apiKeys,
    tenantApiKeys: config.tenantApiKeys,
    principalApiKeys: config.principalApiKeys,
    rateLimitPerMin: config.rateLimitPerMin,
    trustProxyHops: config.trustProxyHops,
  });
  return { provider, service, app, config };
}

export function createDefaultMemoryCore(options: CreateMemoryCoreOptions = {}) {
  const config = options.config || loadConfig();
  const provider = options.provider || createMemoryProvider({
    kind: config.providerKind,
    filePath: config.filePath,
    postgresUrl: config.postgresUrl,
    autoMigrate: config.postgresAutoMigrate,
    embeddingModel: config.embeddingModel,
    embedderSpec: config.embedder,
  });
  const service = new MemoryCoreService(provider, {
    extractor: createExtractor(config.extractor),
    reranker: createReranker(config.reranker ?? { kind: "none" }),
    rerankerMinScore: config.rerankerMinScore,
  });
  const app = createMemoryCoreApp(service, {
    apiKeys: config.apiKeys,
    tenantApiKeys: config.tenantApiKeys,
    principalApiKeys: config.principalApiKeys,
    rateLimitPerMin: config.rateLimitPerMin,
    trustProxyHops: config.trustProxyHops,
  });
  return { provider, service, app, config };
}
