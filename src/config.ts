import path from "node:path";
import { z } from "zod";
import type { MemoryProviderKind } from "./providers/factory.js";

// Kept in lockstep with MemoryProviderKind: `satisfies` rejects unknown kinds and the
// assignment below fails to compile if a kind is ever added without listing it here.
const PROVIDER_KINDS = ["in-memory", "file", "enhanced", "dual-layer", "postgres"] as const satisfies readonly MemoryProviderKind[];
type AssertNever<T extends never> = T;
type ProviderKindsAreExhaustive = AssertNever<Exclude<MemoryProviderKind, (typeof PROVIDER_KINDS)[number]>>;

const envSchema = z.object({
  PORT: z.string().optional(),
  HOST: z.string().optional(),
  MEMORY_PROVIDER: z.enum(PROVIDER_KINDS).optional(),
  MEMORY_FILE_PATH: z.string().optional(),
  MEMORY_CORE_API_KEYS: z.string().optional(),
  MEMORY_RATE_LIMIT_PER_MIN: z.string().optional(),
  // zod strips unknown keys, so DATABASE_URL must be declared to be readable.
  MEMORY_PG_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  MEMORY_PG_AUTO_MIGRATE: z.string().optional(),
  MEMORY_EMBEDDING_MODEL: z.string().optional(),
});

export interface MemoryCoreConfig {
  port: number;
  host: string;
  providerKind: MemoryProviderKind;
  filePath: string;
  apiKeys: Set<string>;
  rateLimitPerMin: number;
  postgresUrl?: string;
  postgresAutoMigrate: boolean;
  embeddingModel?: string;
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

function parseApiKeys(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MemoryCoreConfig {
  const parsed = envSchema.parse(env);
  return {
    port: parsePort(parsed.PORT),
    host: parsed.HOST || "0.0.0.0",
    providerKind: parsed.MEMORY_PROVIDER || "in-memory",
    filePath: parsed.MEMORY_FILE_PATH || path.join(process.cwd(), "data", "memory-core.json"),
    apiKeys: parseApiKeys(parsed.MEMORY_CORE_API_KEYS),
    rateLimitPerMin: parseRateLimit(parsed.MEMORY_RATE_LIMIT_PER_MIN),
    postgresUrl: parsed.MEMORY_PG_URL || parsed.DATABASE_URL,
    postgresAutoMigrate: parsed.MEMORY_PG_AUTO_MIGRATE === "true",
    embeddingModel: parsed.MEMORY_EMBEDDING_MODEL,
  };
}
