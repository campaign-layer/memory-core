import path from "node:path";
import { z } from "zod";
import type { ExtractorKind, ExtractorSpec } from "./extraction/types.js";
import type { MemoryProviderKind } from "./providers/factory.js";
import type { EmbedderKind, EmbedderSpec } from "./retrieval/embedder.js";
import type { RerankerKind, RerankerSpec } from "./retrieval/rerank.js";
import type { PrincipalApiKey } from "./http.js";

// Kept in lockstep with MemoryProviderKind: `satisfies` rejects unknown kinds and the
// assignment below fails to compile if a kind is ever added without listing it here.
const PROVIDER_KINDS = ["in-memory", "file", "enhanced", "dual-layer", "postgres"] as const satisfies readonly MemoryProviderKind[];
type AssertNever<T extends never> = T;
type ProviderKindsAreExhaustive = AssertNever<Exclude<MemoryProviderKind, (typeof PROVIDER_KINDS)[number]>>;

// Same lockstep guard for EmbedderKind.
const EMBEDDER_KINDS = ["none", "local", "hash", "voyage", "openai"] as const satisfies readonly EmbedderKind[];
type EmbedderKindsAreExhaustive = AssertNever<Exclude<EmbedderKind, (typeof EMBEDDER_KINDS)[number]>>;

// Same lockstep guard for ExtractorKind.
const EXTRACTOR_KINDS = ["none", "llm"] as const satisfies readonly ExtractorKind[];
type ExtractorKindsAreExhaustive = AssertNever<Exclude<ExtractorKind, (typeof EXTRACTOR_KINDS)[number]>>;

const RERANKER_KINDS = ["none", "voyage"] as const satisfies readonly RerankerKind[];
type RerankerKindsAreExhaustive = AssertNever<Exclude<RerankerKind, (typeof RERANKER_KINDS)[number]>>;

const envSchema = z.object({
  PORT: z.string().optional(),
  HOST: z.string().optional(),
  MEMORY_PROVIDER: z.enum(PROVIDER_KINDS).optional(),
  MEMORY_FILE_PATH: z.string().optional(),
  MEMORY_CORE_API_KEYS: z.string().optional(),
  MEMORY_CORE_TENANT_API_KEYS: z.string().optional(),
  MEMORY_CORE_PRINCIPAL_API_KEYS: z.string().optional(),
  MEMORY_RATE_LIMIT_PER_MIN: z.string().optional(),
  MEMORY_TRUST_PROXY_HOPS: z.string().optional(),
  // zod strips unknown keys, so DATABASE_URL must be declared to be readable.
  MEMORY_PG_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  MEMORY_PG_AUTO_MIGRATE: z.string().optional(),
  MEMORY_EMBEDDER: z.enum(EMBEDDER_KINDS).optional(),
  MEMORY_EMBEDDING_MODEL: z.string().optional(),
  MEMORY_EMBEDDING_DIMS: z.string().optional(),
  MEMORY_RERANKER: z.enum(RERANKER_KINDS).optional(),
  MEMORY_RERANKER_MODEL: z.string().optional(),
  MEMORY_RERANKER_MIN_SCORE: z.string().optional(),
  MEMORY_EXTRACTOR: z.enum(EXTRACTOR_KINDS).optional(),
  MEMORY_EXTRACTOR_BASE_URL: z.string().optional(),
  MEMORY_EXTRACTOR_API_KEY: z.string().optional(),
  MEMORY_EXTRACTOR_MODEL: z.string().optional(),
  MEMORY_EXTRACTOR_BATCH_SIZE: z.string().optional(),
});

export interface MemoryCoreConfig {
  port: number;
  host: string;
  providerKind: MemoryProviderKind;
  filePath: string;
  /** Global operator credentials. These can access every tenant and run compaction. */
  apiKeys: Set<string>;
  /** Trusted tenant administrators/identity assertors for the listed tenant(s). */
  tenantApiKeys?: Map<string, Set<string>>;
  /** Normal agent credentials bound to an exact tenant/space/app/actor. */
  principalApiKeys?: PrincipalApiKey[];
  rateLimitPerMin: number;
  trustProxyHops?: number;
  postgresUrl?: string;
  postgresAutoMigrate: boolean;
  /** Label only; postgres stores it next to each vector. `embedder.model` drives selection. */
  embeddingModel?: string;
  embedder: EmbedderSpec;
  reranker?: RerankerSpec;
  /** Final cross-encoder score gate. Zero keeps every reranked candidate. */
  rerankerMinScore?: number;
  extractor: ExtractorSpec;
}

function parsePort(raw: string | undefined): number {
  const value = Number(raw ?? "7401");
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid PORT value: ${raw}`);
  }
  return value;
}

function parseRateLimit(raw: string | undefined): number {
  const value = Number(raw ?? "120");
  if (!Number.isFinite(value) || value < 10 || value > 10000) {
    throw new Error(`Invalid MEMORY_RATE_LIMIT_PER_MIN value: ${raw}`);
  }
  return value;
}

function parseTrustProxyHops(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`Invalid MEMORY_TRUST_PROXY_HOPS value: ${raw} (expected an integer in 1..10)`);
  }
  return value;
}

function parseApiKeys(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function parseTenantApiKeys(raw: string | undefined): Map<string, Set<string>> {
  if (!raw) return new Map();

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Do not echo the configuration value: it contains credentials.
    throw new Error("Invalid MEMORY_CORE_TENANT_API_KEYS value: expected a JSON object");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid MEMORY_CORE_TENANT_API_KEYS value: expected a JSON object");
  }

  const entries = Object.entries(value);
  if (entries.length > 1_000) {
    throw new Error("Invalid MEMORY_CORE_TENANT_API_KEYS value: at most 1000 tenants are allowed");
  }

  const result = new Map<string, Set<string>>();
  for (const [tenantId, candidateKeys] of entries) {
    if (!tenantId || tenantId !== tenantId.trim() || tenantId.length > 256) {
      throw new Error(
        "Invalid MEMORY_CORE_TENANT_API_KEYS value: tenant ids must be 1..256 characters without surrounding whitespace",
      );
    }
    if (!Array.isArray(candidateKeys) || candidateKeys.length < 1 || candidateKeys.length > 100) {
      throw new Error(
        "Invalid MEMORY_CORE_TENANT_API_KEYS value: each tenant must have an array of 1..100 keys",
      );
    }

    const keys = new Set<string>();
    for (const candidate of candidateKeys) {
      if (
        typeof candidate !== "string"
        || !candidate
        || candidate !== candidate.trim()
        || candidate.length > 4_096
      ) {
        throw new Error(
          "Invalid MEMORY_CORE_TENANT_API_KEYS value: keys must be 1..4096 characters without surrounding whitespace",
        );
      }
      keys.add(candidate);
    }
    result.set(tenantId, keys);
  }

  return result;
}

function parsePrincipalApiKeys(raw: string | undefined): PrincipalApiKey[] {
  if (!raw) return [];

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid MEMORY_CORE_PRINCIPAL_API_KEYS value: expected a JSON array");
  }

  const trimmedIdentity = z.string().min(1).max(256).refine((item) => item === item.trim());
  const schema = z.array(z.object({
    key: z.string().min(1).max(4_096).refine((item) => item === item.trim()),
    tenantId: trimmedIdentity,
    spaceId: trimmedIdentity.optional(),
    appId: trimmedIdentity,
    actorId: trimmedIdentity,
  }).strict()).max(1_000);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // Do not echo Zod's input values: this configuration contains credentials.
    throw new Error(
      "Invalid MEMORY_CORE_PRINCIPAL_API_KEYS value: expected at most 1000 exact key/tenantId/spaceId?/appId/actorId grants",
    );
  }
  return parsed.data;
}

function assertCredentialSeparation(
  globalKeys: Set<string>,
  tenantApiKeys: Map<string, Set<string>>,
  principalApiKeys: PrincipalApiKey[],
): void {
  const tenantAdminKeys = new Set<string>();
  for (const keys of tenantApiKeys.values()) {
    for (const key of keys) {
      tenantAdminKeys.add(key);
      if (globalKeys.has(key)) {
        // Do not identify the credential in the error.
        throw new Error("A memory-core API key cannot be both global and tenant-scoped");
      }
    }
  }
  for (const principal of principalApiKeys) {
    if (globalKeys.has(principal.key) || tenantAdminKeys.has(principal.key)) {
      throw new Error("A memory-core API key cannot combine operator, tenant-admin, and principal grants");
    }
  }
}

function parseDims(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  // Upper bound matches the postgres provider's pgvector column guard.
  if (!Number.isInteger(value) || value < 1 || value > 16000) {
    throw new Error(`Invalid MEMORY_EMBEDDING_DIMS value: ${raw} (expected an integer in 1..16000)`);
  }
  return value;
}

function parseUnitInterval(raw: string | undefined, name: string, defaultValue: number): number {
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid ${name} value: ${raw} (expected a number in 0..1)`);
  }
  return value;
}

/**
 * Reads the embedder selection on its own, so a provider factory can resolve one
 * without building a whole MemoryCoreConfig.
 *
 * `none` is the default: an existing deployment keeps today's BM25-only ranking
 * until MEMORY_EMBEDDER is set explicitly.
 */
export function parseEmbedderSpec(env: NodeJS.ProcessEnv = process.env): EmbedderSpec {
  const parsed = envSchema.parse(env);
  return {
    kind: parsed.MEMORY_EMBEDDER || "none",
    model: parsed.MEMORY_EMBEDDING_MODEL,
    dims: parseDims(parsed.MEMORY_EMBEDDING_DIMS),
  };
}

export function parseRerankerSpec(env: NodeJS.ProcessEnv = process.env): RerankerSpec {
  const parsed = envSchema.parse(env);
  return {
    kind: parsed.MEMORY_RERANKER || "none",
    model: parsed.MEMORY_RERANKER_MODEL,
  };
}

function parseBatchSize(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  // Upper bound is about attribution quality, not tokens: past ~200 turns per
  // call the model starts mis-numbering which turn a fact came from.
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error(`Invalid MEMORY_EXTRACTOR_BATCH_SIZE value: ${raw} (expected an integer in 1..200)`);
  }
  return value;
}

/**
 * Reads the extractor selection on its own, mirroring parseEmbedderSpec.
 *
 * `none` is the default and is non-negotiable: a production service on the file
 * provider must keep its exact current write behaviour until MEMORY_EXTRACTOR is
 * set explicitly.
 */
export function parseExtractorSpec(env: NodeJS.ProcessEnv = process.env): ExtractorSpec {
  const parsed = envSchema.parse(env);
  return {
    kind: parsed.MEMORY_EXTRACTOR || "none",
    baseUrl: parsed.MEMORY_EXTRACTOR_BASE_URL,
    apiKey: parsed.MEMORY_EXTRACTOR_API_KEY,
    model: parsed.MEMORY_EXTRACTOR_MODEL,
    batchSize: parseBatchSize(parsed.MEMORY_EXTRACTOR_BATCH_SIZE),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MemoryCoreConfig {
  const parsed = envSchema.parse(env);
  const apiKeys = parseApiKeys(parsed.MEMORY_CORE_API_KEYS);
  const tenantApiKeys = parseTenantApiKeys(parsed.MEMORY_CORE_TENANT_API_KEYS);
  const principalApiKeys = parsePrincipalApiKeys(parsed.MEMORY_CORE_PRINCIPAL_API_KEYS);
  assertCredentialSeparation(apiKeys, tenantApiKeys, principalApiKeys);
  return {
    port: parsePort(parsed.PORT),
    host: parsed.HOST || "0.0.0.0",
    providerKind: parsed.MEMORY_PROVIDER || "in-memory",
    filePath: parsed.MEMORY_FILE_PATH || path.join(process.cwd(), "data", "memory-core.json"),
    apiKeys,
    tenantApiKeys,
    principalApiKeys,
    rateLimitPerMin: parseRateLimit(parsed.MEMORY_RATE_LIMIT_PER_MIN),
    trustProxyHops: parseTrustProxyHops(parsed.MEMORY_TRUST_PROXY_HOPS),
    postgresUrl: parsed.MEMORY_PG_URL || parsed.DATABASE_URL,
    postgresAutoMigrate: parsed.MEMORY_PG_AUTO_MIGRATE === "true",
    embeddingModel: parsed.MEMORY_EMBEDDING_MODEL,
    embedder: parseEmbedderSpec(env),
    reranker: parseRerankerSpec(env),
    rerankerMinScore: parseUnitInterval(
      parsed.MEMORY_RERANKER_MIN_SCORE,
      "MEMORY_RERANKER_MIN_SCORE",
      0,
    ),
    extractor: parseExtractorSpec(env),
  };
}
