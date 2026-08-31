import { parseEmbedderSpec } from "./config.js";
import { createMemoryProvider } from "./providers/factory.js";

function requiredPostgresUrl(env: NodeJS.ProcessEnv): string {
  const value = env.MEMORY_PG_URL || env.DATABASE_URL;
  if (!value || value !== value.trim()) {
    throw new Error("memory-core migrate requires an explicit MEMORY_PG_URL or DATABASE_URL");
  }
  try {
    const parsed = new URL(value);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error("invalid protocol or host");
    }
  } catch {
    // Never include the connection string in an error because it may contain a password.
    throw new Error("memory-core migrate requires a valid postgres:// or postgresql:// URL");
  }
  return value;
}

const postgresUrl = requiredPostgresUrl(process.env);
const embedderSpec = parseEmbedderSpec(process.env);
const provider = createMemoryProvider({
  kind: "postgres",
  postgresUrl,
  autoMigrate: false,
  embeddingModel: process.env.MEMORY_EMBEDDING_MODEL,
  embedderSpec,
});

try {
  if (!provider.migrate) throw new Error("postgres provider does not expose migrate()");
  await provider.migrate();
  console.log("[memory-core] migrations applied successfully");
} finally {
  await provider.close?.();
}
