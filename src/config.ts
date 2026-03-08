import path from "node:path";
import { z } from "zod";
import type { MemoryProviderKind } from "./providers/factory.js";

const envSchema = z.object({
  PORT: z.string().optional(),
  HOST: z.string().optional(),
  MEMORY_PROVIDER: z.enum(["in-memory", "file"]).optional(),
  MEMORY_FILE_PATH: z.string().optional(),
  MEMORY_CORE_API_KEYS: z.string().optional(),
  MEMORY_RATE_LIMIT_PER_MIN: z.string().optional(),
});

export interface MemoryCoreConfig {
  port: number;
  host: string;
  providerKind: MemoryProviderKind;
  filePath: string;
  apiKeys: Set<string>;
  rateLimitPerMin: number;
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
    providerKind: (parsed.MEMORY_PROVIDER || "in-memory") as MemoryProviderKind,
    filePath: parsed.MEMORY_FILE_PATH || path.join(process.cwd(), "data", "memory-core.json"),
    apiKeys: parseApiKeys(parsed.MEMORY_CORE_API_KEYS),
    rateLimitPerMin: parseRateLimit(parsed.MEMORY_RATE_LIMIT_PER_MIN),
  };
}
