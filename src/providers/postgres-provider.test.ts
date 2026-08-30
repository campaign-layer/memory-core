import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import pg from "pg";
import {
  DEFAULT_PG_URL,
  MemoryDedupeConflictError,
  PostgresMemoryProvider,
  type EmbeddingProviderLike,
} from "./postgres-provider.js";
import { MemoryCoreService } from "../service.js";
import type { MemoryRecord, MemoryType, MemoryScope } from "../types.js";

const { Client, Pool } = pg;

const TENANT_PREFIX = "pgtest_";
const RUN = randomUUID().slice(0, 8);
const APP = "app_main";

function tenant(label: string): string {
  return `${TENANT_PREFIX}${RUN}_${label}`;
}

function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

function maintenanceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

/** Creates the dev database if the server is up but the database is missing. */
async function ensureDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to create a database with an unexpected name: ${name}`);
  }
  const admin = new Client({ connectionString: maintenanceUrl(url), connectionTimeoutMillis: 4_000 });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

interface Preflight {
  skip?: string;
  skipVector?: string;
  url: string;
  vectorVersion?: string;
}

async function preflight(): Promise<Preflight> {
  const url = process.env.DATABASE_URL || process.env.MEMORY_PG_URL || DEFAULT_PG_URL;
  try {
    await ensureDatabase(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, skip: `Postgres unavailable at ${url} (${message})`, skipVector: "Postgres unavailable" };
  }

  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 4_000, allowExitOnIdle: true });
  try {
    const provider = new PostgresMemoryProvider({ pool });
    await provider.migrate();
    const extension = await pool.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    const vectorVersion = extension.rows[0]?.extversion;
    if (vectorVersion) {
      // Provision fixture dimensions in the explicit test/deploy phase. Search
      // and ingest are intentionally forbidden from running DDL on demand.
      await pool.query("SELECT memory_core_ensure_embedding_dim(8)");
    }
    return {
      url,
      vectorVersion,
      skipVector: vectorVersion
        ? undefined
        : "pgvector not installed in this database (run: CREATE EXTENSION vector)",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, skip: `migration failed against ${url} (${message})`, skipVector: "migration failed" };
  } finally {
    await pool.end();
  }
}

const env = await preflight();
if (env.skip) {
  console.log(`[postgres-provider.test] SKIPPING: ${env.skip}`);
} else {
  console.log(`[postgres-provider.test] database=${databaseName(env.url)} pgvector=${env.vectorVersion ?? "absent"}`);
  if (env.skipVector) console.log(`[postgres-provider.test] vector tests skipped: ${env.skipVector}`);
}

const skip = env.skip;
const skipVector = env.skip || env.skipVector;

const provider = env.skip ? null : new PostgresMemoryProvider({ connectionString: env.url, poolMax: 6 });

/**
 * Test double, not a model: a fixed text -> unit-vector lookup. The hybrid test
 * needs deterministic geometry so it verifies the fusion SQL, not embedding
 * quality. Vectors are declared next to the fixtures that use them.
 */
class FixtureEmbedder implements EmbeddingProviderLike {
  constructor(
    readonly dims: number,
    private readonly table: Map<string, number[]>,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vector = this.table.get(text);
      if (!vector) throw new Error(`FixtureEmbedder: no fixture vector for ${JSON.stringify(text)}`);
      if (vector.length !== this.dims) throw new Error(`FixtureEmbedder: fixture for ${text} has wrong width`);
      return Float32Array.from(vector);
    });
  }
}

/** Unit vector in an 8-dim space at the given cosine from the query axis e0. */
function atCosine(cosine: number): number[] {
  const orthogonal = Math.sqrt(Math.max(1 - cosine * cosine, 0));
  return [cosine, orthogonal, 0, 0, 0, 0, 0, 0];
}

let sequence = 0;

function record(overrides: Partial<MemoryRecord> & { tenantId: string; text: string }): MemoryRecord {
  sequence += 1;
  const now = new Date().toISOString();
  return {
    id: `mem_${RUN}_${sequence}`,
    appId: APP,
    actorId: "actor_1",
    threadId: null,
    scope: "actor" as MemoryScope,
    memoryType: "fact" as MemoryType,
    summary: null,
    metadata: {},
    confidence: 0.7,
    importance: 0.5,
    status: "active",
    source: { sourceType: "test", sourceId: "fixture" },
    decayPolicy: { kind: "none" },
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    stats: { selectedCount: 0, positiveCount: 0, negativeCount: 0 },
    ...overrides,
    spaceId: overrides.spaceId ?? overrides.actorId ?? "actor_1",
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function ids(hits: Array<{ memory: MemoryRecord }>): string[] {
  return hits.map((hit) => hit.memory.id);
}

after(async () => {
  if (provider) {
    const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
    // Embedding rows cascade from memories.
    await pool.query("DELETE FROM memories WHERE tenant_id LIKE $1", [`${TENANT_PREFIX}${RUN}%`]);
    await pool.end();
    await provider.close();
  }
});

test("health rejects a reachable but pre-space schema", async () => {
  const fakePool = {
    on() {},
    async query() {
      return {
        rowCount: 1,
        rows: [{
          server_version: "16.4",
          vector_version: null,
          memory_table: "memories",
          memory_space_column: false,
          estimated_rows: "12",
          embedding_table: null,
          embedding_space_column: false,
        }],
      };
    },
  };
  const schemaProbe = new PostgresMemoryProvider({ pool: fakePool as never });
  const status = await schemaProbe.health();
  assert.equal(status.ok, false);
  assert.match(status.detail ?? "", /apply migration 002_memory_spaces/);
});

test("health reports connectivity, server version and constant-cost row estimates", { skip }, async () => {
  const status = await provider!.health();
  assert.equal(status.ok, true);
  assert.equal(status.provider, "postgres");
  assert.match(status.detail ?? "", /pg=\d+/);
  // reltuples is -1 until a freshly created relation has been analyzed.
  assert.match(status.detail ?? "", /rows_estimate=-?\d+/);
});

test("health rejects same-named dedupe indexes on the wrong table or definition", { skip }, async () => {
  const schema = `mc_health_dedupe_${RUN.replace(/-/g, "")}`;
  assert.match(schema, /^[a-z0-9_]+$/);
  const admin = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedPool = new Pool({
    connectionString: env.url,
    options: `-c search_path=${schema},public`,
    max: 1,
    allowExitOnIdle: true,
  });
  const scopedProvider = new PostgresMemoryProvider({ pool: scopedPool });
  try {
    for (const filename of ["001_init.sql", "002_memory_spaces.sql", "003_concurrent_dedupe.sql"]) {
      await scopedPool.query(await readFile(path.resolve("migrations", filename), "utf8"));
    }
    assert.equal((await scopedProvider.health()).ok, true);

    await scopedPool.query("DROP INDEX memories_active_actor_dedupe_uidx");
    await scopedPool.query("CREATE TABLE readiness_decoy (id text PRIMARY KEY)");
    await scopedPool.query("CREATE UNIQUE INDEX memories_active_actor_dedupe_uidx ON readiness_decoy (id)");
    const wrongTable = await scopedProvider.health();
    assert.equal(wrongTable.ok, false);
    assert.match(wrongTable.detail ?? "", /apply migration 003_concurrent_dedupe/);

    await scopedPool.query("DROP INDEX memories_active_actor_dedupe_uidx");
    await scopedPool.query("CREATE UNIQUE INDEX memories_active_actor_dedupe_uidx ON memories (id)");
    const wrongDefinition = await scopedProvider.health();
    assert.equal(wrongDefinition.ok, false);
    assert.match(wrongDefinition.detail ?? "", /apply migration 003_concurrent_dedupe/);
  } finally {
    await scopedProvider.close();
    await scopedPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("migration ledger records ordered schema versions and source checksums", { skip }, async () => {
  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  try {
    const versions = await pool.query<{ version: string; checksum: string | null }>(
      "SELECT version, checksum FROM memory_core_migrations WHERE version LIKE '00%' ORDER BY version",
    );
    assert.deepEqual(
      versions.rows.map((row) => row.version),
      ["001_init", "002_memory_spaces", "003_concurrent_dedupe"],
    );
    for (const row of versions.rows) assert.match(row.checksum ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await pool.end();
  }
});

test("migration ledger rejects an edited applied migration", { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-core-migration-test-"));
  const migrationFile = path.join(dir, `checksum_probe_${RUN}.sql`);
  const version = path.basename(migrationFile, ".sql");
  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  try {
    await writeFile(migrationFile, "SELECT 1;\n", "utf8");
    const first = new PostgresMemoryProvider({ connectionString: env.url, migrationFile });
    await first.migrate();
    await first.close();

    await writeFile(migrationFile, "SELECT 2;\n", "utf8");
    const changed = new PostgresMemoryProvider({ connectionString: env.url, migrationFile });
    try {
      await assert.rejects(() => changed.migrate(), /checksum mismatch.*never edit an applied migration/);
    } finally {
      await changed.close();
    }
  } finally {
    await pool.query("DELETE FROM memory_core_migrations WHERE version = $1", [version]);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration work is not killed by the request statement timeout", { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-core-migration-timeout-test-"));
  const migrationFile = path.join(dir, `timeout_probe_${RUN}.sql`);
  const version = path.basename(migrationFile, ".sql");
  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  try {
    await writeFile(migrationFile, "SELECT pg_sleep(0.05);\n", "utf8");
    const slowMigration = new PostgresMemoryProvider({
      connectionString: env.url,
      migrationFile,
      statementTimeoutMs: 1,
    });
    try {
      await slowMigration.migrate();
    } finally {
      await slowMigration.close();
    }
    const applied = await pool.query<{ checksum: string | null }>(
      "SELECT checksum FROM memory_core_migrations WHERE version = $1",
      [version],
    );
    assert.match(applied.rows[0]?.checksum ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await pool.query("DELETE FROM memory_core_migrations WHERE version = $1", [version]);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration 003 consolidates legacy duplicates and leaves five valid unique indexes", { skip }, async () => {
  const schema = `mc_dedupe_migration_${RUN.replace(/-/g, "")}`;
  assert.match(schema, /^[a-z0-9_]+$/);
  const pool = new Pool({ connectionString: env.url, max: 2, allowExitOnIdle: true });
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    for (const filename of ["001_init.sql", "002_memory_spaces.sql"]) {
      await client.query(await readFile(path.resolve("migrations", filename), "utf8"));
    }
    await client.query(
      `INSERT INTO memories (
         id, tenant_id, space_id, app_id, actor_id, scope, memory_type, text,
         metadata, confidence, importance, first_seen_at, last_seen_at, created_at, updated_at, stats
       ) VALUES
       ('legacy_a', 'legacy_tenant', 'legacy_space', 'app_a', 'legacy_actor', 'actor', 'fact',
        'Legacy exact duplicate', '{"a":1,"winner":"old"}', 0.6, 0.4,
        now() - interval '5 days', now() - interval '3 days', now() - interval '5 days',
        now() - interval '3 days', '{"selectedCount":1,"positiveCount":2,"negativeCount":0}'),
       ('legacy_b', 'legacy_tenant', 'legacy_space', 'app_b', 'legacy_actor', 'actor', 'fact',
        ' legacy   EXACT duplicate ', '{"b":2,"winner":"middle"}', 0.8, 0.5,
        now() - interval '4 days', now() - interval '2 days', now() - interval '4 days',
        now() - interval '2 days', '{"selectedCount":2,"positiveCount":0,"negativeCount":1}'),
       ('legacy_c', 'legacy_tenant', 'legacy_space', 'app_c', 'legacy_actor', 'actor', 'fact',
        'LEGACY exact duplicate', '{"c":3,"winner":"new"}', 0.7, 0.9,
        now() - interval '3 days', now() - interval '1 day', now() - interval '3 days',
        now() - interval '1 day', '{"selectedCount":3,"positiveCount":1,"negativeCount":2,"accessCount":4}')`,
    );

    await client.query(await readFile(path.resolve("migrations", "003_concurrent_dedupe.sql"), "utf8"));
    const rows = await client.query<{
      id: string;
      status: string;
      metadata: Record<string, unknown>;
      stats: Record<string, number>;
      confidence: number;
      importance: number;
    }>("SELECT id, status, metadata, stats, confidence, importance FROM memories ORDER BY id");
    assert.equal(rows.rows.length, 3);
    const winner = rows.rows.find((row) => row.status === "active");
    assert.equal(winner?.id, "legacy_c");
    assert.equal(rows.rows.filter((row) => row.status === "superseded").length, 2);
    assert.deepEqual(winner?.metadata, { a: 1, b: 2, c: 3, winner: "new" });
    assert.deepEqual(winner?.stats, {
      selectedCount: 6,
      positiveCount: 3,
      negativeCount: 3,
      accessCount: 4,
    });
    assert.equal(winner?.confidence, 0.8);
    assert.equal(winner?.importance, 0.9);
    for (const loser of rows.rows.filter((row) => row.status === "superseded")) {
      assert.equal(loser.metadata.supersededBy, "legacy_c");
      assert.equal(loser.metadata.supersedeReason, "migration-003-concurrent-dedupe");
    }

    const indexes = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE n.nspname = $1
          AND c.relname LIKE 'memories_active_%_dedupe_uidx'
          AND i.indisunique AND i.indisready AND i.indisvalid`,
      [schema],
    );
    assert.equal(Number(indexes.rows[0]?.count), 5);
  } finally {
    client.release();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

test("migration 003 rejects malformed legacy decay policies atomically", { skip }, async () => {
  const schema = `mc_dedupe_decay_${RUN.replace(/-/g, "")}`;
  assert.match(schema, /^[a-z0-9_]+$/);
  const pool = new Pool({ connectionString: env.url, max: 2, allowExitOnIdle: true });
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    for (const filename of ["001_init.sql", "002_memory_spaces.sql"]) {
      await client.query(await readFile(path.resolve("migrations", filename), "utf8"));
    }
    await client.query(
      `INSERT INTO memories (
         id, tenant_id, space_id, app_id, actor_id, scope, memory_type, text, decay_policy
       ) VALUES (
         'invalid_decay', 'legacy_tenant', 'legacy_space', 'legacy_app', 'legacy_actor',
         'actor', 'fact', 'Malformed decay must not become an active zombie', '{}'::jsonb
       )`,
    );

    await assert.rejects(
      async () => client.query(await readFile(path.resolve("migrations", "003_concurrent_dedupe.sql"), "utf8")),
      /memories_decay_policy_shape_check/,
    );
    await client.query("ROLLBACK");

    const rolledBack = await client.query<{ constraint_exists: boolean; index_count: string }>(
      `SELECT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'memories'::regclass
                   AND conname = 'memories_decay_policy_shape_check'
              ) AS constraint_exists,
              (SELECT count(*)::text
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = current_schema()
                  AND c.relname LIKE 'memories_active_%_dedupe_uidx') AS index_count`,
    );
    assert.equal(rolledBack.rows[0]?.constraint_exists, false);
    assert.equal(Number(rolledBack.rows[0]?.index_count), 0);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

test("fails closed when tenant or app scope is missing", { skip }, async () => {
  await assert.rejects(
    () => provider!.search({ query: "anything", filters: { tenantId: "", appId: APP } }),
    /requires both tenantId and appId/,
  );
  await assert.rejects(
    () => provider!.search({ query: "anything", filters: { tenantId: tenant("a"), appId: "" } }),
    /requires both tenantId and appId/,
  );
  await assert.rejects(() => provider!.listByActor(tenant("a"), "", "actor_1"), /requires both tenantId and appId/);
  await assert.rejects(
    () => provider!.ingest([record({ tenantId: "", text: "unscoped" })]),
    /requires both tenantId and appId/,
  );
});

test("ingest round-trips a record through getById", { skip }, async () => {
  const t = tenant("roundtrip");
  const input = record({
    tenantId: t,
    text: "The staging cluster is rebuilt every friday afternoon",
    summary: "staging rebuild cadence",
    threadId: "thread_7",
    scope: "thread",
    memoryType: "project",
    metadata: { team: "platform", priority: 3, urgent: true },
    confidence: 0.82,
    importance: 0.9,
    decayPolicy: { kind: "time", ttlDays: 90 },
  });

  const [saved] = await provider!.ingest([input]);
  assert.equal(saved.id, input.id);

  const fetched = await provider!.getById(input.id, { tenantId: t, appId: APP, actorId: "actor_1", accessThreadId: "thread_7" });
  assert.ok(fetched);
  assert.equal(fetched.text, input.text);
  assert.equal(fetched.summary, input.summary);
  assert.equal(fetched.threadId, "thread_7");
  assert.equal(fetched.scope, "thread");
  assert.equal(fetched.memoryType, "project");
  assert.deepEqual(fetched.metadata, { team: "platform", priority: 3, urgent: true });
  assert.equal(Math.round(fetched.confidence * 100) / 100, 0.82);
  assert.equal(fetched.importance, 0.9);
  assert.deepEqual(fetched.decayPolicy, { kind: "time", ttlDays: 90 });
  assert.deepEqual(fetched.source, { sourceType: "test", sourceId: "fixture" });
  assert.deepEqual(fetched.stats, { selectedCount: 0, positiveCount: 0, negativeCount: 0 });
  assert.equal(new Date(fetched.createdAt).toISOString(), input.createdAt);
});

test("ingest batches many records in a single transaction", { skip }, async () => {
  const t = tenant("batch");
  const batch = Array.from({ length: 250 }, (_, index) =>
    record({ tenantId: t, actorId: "actor_batch", text: `batched observation number ${index}` }),
  );

  const saved = await provider!.ingest(batch);
  assert.equal(saved.length, 250);

  const listed = await provider!.listByActor(t, APP, "actor_batch");
  assert.equal(listed.length, 250);
});

test("re-ingesting the same id upserts and preserves creation timestamps", { skip }, async () => {
  const t = tenant("upsert");
  const born = daysAgo(10);
  const original = record({ tenantId: t, text: "first version", createdAt: born, firstSeenAt: born });
  await provider!.ingest([original]);

  const revised = { ...original, text: "second version", createdAt: new Date().toISOString(), importance: 0.99 };
  const updated = await provider!.update(revised);
  assert.equal(updated.text, "second version");
  assert.equal(updated.createdAt, born);
  assert.equal(updated.firstSeenAt, born);

  const listed = await provider!.listByActor(t, APP, "actor_1");
  assert.equal(listed.length, 1);
});

test("findDuplicate is case- and whitespace-insensitive and scope-aware", { skip }, async () => {
  const t = tenant("dedup");
  const original = record({ tenantId: t, text: "Deploys are frozen during the December holidays" });
  await provider!.ingest([original]);

  const noisy = record({ tenantId: t, text: "  deploys   are FROZEN during the december HOLIDAYS  " });
  const hit = await provider!.findDuplicate(noisy);
  assert.ok(hit, "normalized text should match an existing active row");
  assert.equal(hit.id, original.id);

  assert.equal(await provider!.findDuplicate(record({ ...noisy, actorId: "other_actor" })), null);
  assert.equal(await provider!.findDuplicate(record({ ...noisy, memoryType: "preference" })), null);
  assert.equal(await provider!.findDuplicate(record({ ...noisy, tenantId: tenant("dedup_other") })), null);
  assert.equal(
    (await provider!.findDuplicate(record({ ...noisy, appId: "app_other" })))?.id,
    original.id,
    "actor memory dedupes across producer apps inside one space",
  );
  assert.equal(
    await provider!.findDuplicate(record({ ...noisy, scope: "app", appId: "app_other" })),
    null,
    "app-scoped identity still includes the producer app",
  );
  assert.equal(await provider!.findDuplicate(record({ tenantId: t, text: "something else entirely" })), null);
});

test("findDuplicate uses the dedup index rather than a table scan", { skip }, async () => {
  const t = tenant("dedupplan");
  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  try {
    // Enough rows that a sequential scan is genuinely the cheaper alternative,
    // so choosing the index is the planner's decision and not a small-table tie.
    await pool.query(
      `INSERT INTO memories (id, tenant_id, space_id, app_id, actor_id, scope, memory_type, text, status)
       SELECT 'plan_${RUN}_' || g, $1, 'actor_plan', $2, 'actor_plan', 'actor', 'fact', 'probe row ' || g, 'active'
         FROM generate_series(1, 5000) g`,
      [t, APP],
    );
    await pool.query("ANALYZE memories");

    const plan = await pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT id FROM memories m
        WHERE m.tenant_id = $1 AND m.scope = 'actor' AND m.memory_type = $2
          AND m.status = 'active'
          AND memory_core_text_sha256(lower(regexp_replace(btrim(m.text), '\\s+', ' ', 'g'))) =
              memory_core_text_sha256(lower(regexp_replace(btrim($3::text), '\\s+', ' ', 'g')))
          AND lower(regexp_replace(btrim(m.text), '\\s+', ' ', 'g')) =
              lower(regexp_replace(btrim($3::text), '\\s+', ' ', 'g'))
          AND m.space_id = $4 AND m.actor_id = $5`,
      [t, "fact", "probe row 42", "actor_plan", "actor_plan"],
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(text, /Index Scan using memories_active_actor_dedupe_uidx/, `expected an index scan, got:\n${text}`);
    assert.match(text, /Index Cond:.*memory_core_text_sha256/, `SHA-256 should be an index condition, got:\n${text}`);

    const hit = await provider!.findDuplicate(
      record({ tenantId: t, actorId: "actor_plan", text: "  PROBE   Row 42 " }),
    );
    assert.equal(hit?.id, `plan_${RUN}_42`);
  } finally {
    await pool.query("DELETE FROM memories WHERE tenant_id = $1", [t]).catch(() => {});
    await pool.end();
  }
});

test("atomic exact ingest matches all five visibility loci", { skip }, async () => {
  const service = new MemoryCoreService(provider!);
  const cases: Array<{
    label: string;
    first: Parameters<typeof service.ingest>[0]["observations"][number];
    second: Parameters<typeof service.ingest>[0]["observations"][number];
  }> = [
    {
      label: "tenant",
      first: {
        tenantId: tenant("atomic_scopes_tenant"), spaceId: "space_a", appId: "app_a", actorId: "actor_a",
        threadId: "thread_a", scope: "tenant", memoryType: "fact", text: "Tenant policy is immutable",
        source: { sourceType: "test", sourceId: "first" },
      },
      second: {
        tenantId: tenant("atomic_scopes_tenant"), spaceId: "space_b", appId: "app_b", actorId: "actor_b",
        threadId: "thread_b", scope: "tenant", memoryType: "fact", text: "  tenant POLICY is immutable  ",
        source: { sourceType: "test", sourceId: "second" },
      },
    },
    {
      label: "workspace",
      first: {
        tenantId: tenant("atomic_scopes_workspace"), spaceId: "shared", appId: "app_a", actorId: "actor_a",
        scope: "workspace", memoryType: "fact", text: "Shared launch is Tuesday",
        source: { sourceType: "test", sourceId: "first" },
      },
      second: {
        tenantId: tenant("atomic_scopes_workspace"), spaceId: "shared", appId: "app_b", actorId: "actor_b",
        threadId: "irrelevant", scope: "workspace", memoryType: "fact", text: "shared LAUNCH is tuesday",
        source: { sourceType: "test", sourceId: "second" },
      },
    },
    {
      label: "app",
      first: {
        tenantId: tenant("atomic_scopes_app"), spaceId: "shared", appId: "app_a", actorId: "actor_a",
        scope: "app", memoryType: "fact", text: "App deploy window is noon",
        source: { sourceType: "test", sourceId: "first" },
      },
      second: {
        tenantId: tenant("atomic_scopes_app"), spaceId: "shared", appId: "app_a", actorId: "actor_b",
        threadId: "irrelevant", scope: "app", memoryType: "fact", text: "APP deploy window is noon",
        source: { sourceType: "test", sourceId: "second" },
      },
    },
    {
      label: "actor",
      first: {
        tenantId: tenant("atomic_scopes_actor"), spaceId: "shared", appId: "app_a", actorId: "actor_a",
        scope: "actor", memoryType: "fact", text: "Actor prefers concise output",
        source: { sourceType: "test", sourceId: "first" },
      },
      second: {
        tenantId: tenant("atomic_scopes_actor"), spaceId: "shared", appId: "app_b", actorId: "actor_a",
        threadId: "irrelevant", scope: "actor", memoryType: "fact", text: "actor PREFERS concise output",
        source: { sourceType: "test", sourceId: "second" },
      },
    },
    {
      label: "thread",
      first: {
        tenantId: tenant("atomic_scopes_thread"), spaceId: "shared", appId: "app_a", actorId: "actor_a",
        threadId: "thread_a", scope: "thread", memoryType: "fact", text: "Thread decision is final",
        source: { sourceType: "test", sourceId: "first" },
      },
      second: {
        tenantId: tenant("atomic_scopes_thread"), spaceId: "shared", appId: "app_b", actorId: "actor_a",
        threadId: "thread_a", scope: "thread", memoryType: "fact", text: "THREAD decision is final",
        source: { sourceType: "test", sourceId: "second" },
      },
    },
  ];

  for (const fixture of cases) {
    const first = await service.ingest({ observations: [fixture.first] });
    const second = await service.ingest({ observations: [fixture.second] });
    assert.equal(first.created, 1, `${fixture.label}: first observation should create`);
    assert.equal(second.updated, 1, `${fixture.label}: second observation should reinforce`);
    assert.equal(second.created, 0, `${fixture.label}: second observation must not create`);
    assert.equal(second.records[0]?.id, first.records[0]?.id, `${fixture.label}: winner id must be stable`);
  }

  const distinctCases = [
    {
      label: "tenant",
      first: { tenantId: tenant("atomic_distinct_tenant_a"), spaceId: "space", appId: APP, actorId: "actor" },
      second: { tenantId: tenant("atomic_distinct_tenant_b"), spaceId: "space", appId: APP, actorId: "actor" },
      scope: "tenant" as const,
    },
    {
      label: "workspace",
      first: { tenantId: tenant("atomic_distinct_workspace"), spaceId: "space_a", appId: APP, actorId: "actor" },
      second: { tenantId: tenant("atomic_distinct_workspace"), spaceId: "space_b", appId: APP, actorId: "actor" },
      scope: "workspace" as const,
    },
    {
      label: "app",
      first: { tenantId: tenant("atomic_distinct_app"), spaceId: "space", appId: "app_a", actorId: "actor" },
      second: { tenantId: tenant("atomic_distinct_app"), spaceId: "space", appId: "app_b", actorId: "actor" },
      scope: "app" as const,
    },
    {
      label: "actor",
      first: { tenantId: tenant("atomic_distinct_actor"), spaceId: "space", appId: APP, actorId: "actor_a" },
      second: { tenantId: tenant("atomic_distinct_actor"), spaceId: "space", appId: APP, actorId: "actor_b" },
      scope: "actor" as const,
    },
    {
      label: "thread",
      first: {
        tenantId: tenant("atomic_distinct_thread"), spaceId: "space", appId: APP,
        actorId: "actor", threadId: "thread_a",
      },
      second: {
        tenantId: tenant("atomic_distinct_thread"), spaceId: "space", appId: APP,
        actorId: "actor", threadId: "thread_b",
      },
      scope: "thread" as const,
    },
  ];
  for (const fixture of distinctCases) {
    const observation = {
      scope: fixture.scope,
      memoryType: "fact" as const,
      text: `The ${fixture.label} locus remains distinct`,
      source: { sourceType: "test", sourceId: "distinct-locus" },
    };
    const first = await service.ingest({ observations: [{ ...fixture.first, ...observation }] });
    const second = await service.ingest({ observations: [{ ...fixture.second, ...observation }] });
    assert.equal(first.created, 1);
    assert.equal(second.created, 1, `${fixture.label}: a different relevant locus must not reinforce`);
    assert.notEqual(second.records[0]?.id, first.records[0]?.id);
  }
});

test("twenty concurrent service writers return one durable exact-memory id", { skip }, async () => {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  class GatedPostgresProvider extends PostgresMemoryProvider {
    override async ingestOrReinforceExact(candidate: MemoryRecord) {
      arrived += 1;
      if (arrived === 20) release();
      await gate;
      return super.ingestOrReinforceExact(candidate);
    }
  }

  const left = new GatedPostgresProvider({ connectionString: env.url, poolMax: 12 });
  const right = new GatedPostgresProvider({ connectionString: env.url, poolMax: 12 });
  const services = Array.from({ length: 20 }, (_, index) =>
    new MemoryCoreService(index % 2 === 0 ? left : right),
  );
  const t = tenant("atomic_race");
  const canonicalText = "The compatibility soak must run continuously";

  try {
    const settled = await Promise.allSettled(services.map((service, index) => service.ingest({
      observations: [{
        tenantId: t,
        spaceId: "shared-agent-space",
        appId: `framework_${index}`,
        actorId: "agent_operator",
        scope: "actor",
        memoryType: "fact",
        text: index % 2 === 0 ? canonicalText : "  the COMPATIBILITY soak must run continuously  ",
        metadata: { [`writer_${index}`]: true },
        confidence: 0.5 + index / 100,
        importance: 0.4 + index / 100,
        source: { sourceType: "test", sourceId: `writer_${index}` },
      }],
    })));

    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.deepEqual(rejected.map((result) => String(result.reason)), []);
    const results = settled
      .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof services[number]["ingest"]>>> =>
        result.status === "fulfilled")
      .map((result) => result.value);
    assert.equal(results.length, 20);
    assert.equal(results.reduce((sum, result) => sum + result.created, 0), 1);
    assert.equal(results.reduce((sum, result) => sum + result.updated, 0), 19);
    assert.ok(results.every((result) => result.records.length === 1));
    const returnedIds = new Set(results.map((result) => result.records[0]!.id));
    assert.equal(returnedIds.size, 1);

    const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
    try {
      const stored = await pool.query<{ total: string; active: string; ids: string[] }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE status = 'active')::text AS active,
                array_agg(id ORDER BY id) AS ids
           FROM memories
          WHERE tenant_id = $1
            AND scope = 'actor'
            AND space_id = $2
            AND actor_id = $3
            AND memory_type = 'fact'
            AND memory_core_text_sha256(lower(regexp_replace(btrim(text), '\\s+', ' ', 'g'))) =
                memory_core_text_sha256(lower(regexp_replace(btrim($4::text), '\\s+', ' ', 'g')))`,
        [t, "shared-agent-space", "agent_operator", canonicalText],
      );
      assert.equal(Number(stored.rows[0]?.total), 1);
      assert.equal(Number(stored.rows[0]?.active), 1);
      assert.deepEqual(stored.rows[0]?.ids, [...returnedIds]);
    } finally {
      await pool.end();
    }
  } finally {
    await left.close();
    await right.close();
  }
});

test("twenty concurrent writers replace one expired exact memory exactly once", { skip }, async () => {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  class GatedExpiredProvider extends PostgresMemoryProvider {
    override async ingestOrReinforceExact(candidate: MemoryRecord) {
      arrived += 1;
      if (arrived === 20) release();
      await gate;
      return super.ingestOrReinforceExact(candidate);
    }
  }

  const left = new GatedExpiredProvider({ connectionString: env.url, poolMax: 12 });
  const right = new GatedExpiredProvider({ connectionString: env.url, poolMax: 12 });
  const services = Array.from({ length: 20 }, (_, index) =>
    new MemoryCoreService(index % 2 === 0 ? left : right),
  );
  const t = tenant("atomic_expired_race");
  const text = "The expired compatibility decision is replaced once";
  const expired = record({
    tenantId: t,
    actorId: "agent_operator",
    spaceId: "shared-agent-space",
    text,
    decayPolicy: { kind: "time", ttlDays: 1 },
    createdAt: daysAgo(3),
    firstSeenAt: daysAgo(3),
    lastSeenAt: daysAgo(2),
    updatedAt: daysAgo(2),
  });
  await provider!.ingest([expired]);

  try {
    const results = await Promise.all(services.map((service, index) => service.ingest({
      observations: [{
        tenantId: t,
        spaceId: expired.spaceId,
        appId: `framework_expired_${index}`,
        actorId: expired.actorId,
        scope: "actor",
        memoryType: "fact",
        text: index % 2 === 0 ? text : "  the EXPIRED compatibility decision is replaced once  ",
        decayPolicy: { kind: "time", ttlDays: 1 },
        source: { sourceType: "test", sourceId: `expired_writer_${index}` },
      }],
    })));
    assert.equal(results.reduce((sum, result) => sum + result.created, 0), 1);
    assert.equal(results.reduce((sum, result) => sum + result.updated, 0), 19);
    const returnedIds = new Set(results.map((result) => result.records[0]?.id));
    assert.equal(returnedIds.size, 1);
    assert.ok(!returnedIds.has(expired.id));

    const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
    try {
      const stored = await pool.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM memories
          WHERE tenant_id = $1
            AND scope = 'actor'
            AND space_id = $2
            AND actor_id = $3
            AND memory_type = 'fact'
            AND memory_core_text_sha256(lower(regexp_replace(btrim(text), '\\s+', ' ', 'g'))) =
                memory_core_text_sha256(lower(regexp_replace(btrim($4::text), '\\s+', ' ', 'g')))
          ORDER BY id`,
        [t, expired.spaceId, expired.actorId, text],
      );
      assert.equal(stored.rows.length, 2);
      assert.deepEqual(stored.rows.map((row) => row.status).sort(), ["active", "archived"]);
      assert.equal(stored.rows.find((row) => row.status === "active")?.id, [...returnedIds][0]);
    } finally {
      await pool.end();
    }
  } finally {
    await left.close();
    await right.close();
  }
});

test("exact ingest replaces active-but-expired time and inactivity memories", { skip }, async () => {
  const service = new MemoryCoreService(provider!);
  for (const kind of ["time", "inactivity"] as const) {
    const t = tenant(`expired_dedupe_${kind}`);
    const old = record({
      tenantId: t,
      text: `Expired ${kind} memory is replaced`,
      decayPolicy: { kind, ttlDays: 1 },
      createdAt: daysAgo(3),
      firstSeenAt: daysAgo(3),
      lastSeenAt: daysAgo(2),
      updatedAt: daysAgo(2),
    });
    await provider!.ingest([old]);

    const result = await service.ingest({ observations: [{
      tenantId: t,
      appId: APP,
      actorId: old.actorId,
      scope: "actor",
      memoryType: "fact",
      text: old.text,
      decayPolicy: { kind, ttlDays: 1 },
      source: { sourceType: "test", sourceId: "replacement" },
    }] });
    assert.equal(result.created, 1, `${kind}: expired row should not be reinforced`);
    assert.equal(result.updated, 0);
    assert.notEqual(result.records[0]?.id, old.id);

    const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
    try {
      const rows = await pool.query<{ id: string; status: string; reason: string | null }>(
        `SELECT id, status, metadata ->> 'archiveReason' AS reason
           FROM memories WHERE tenant_id = $1 ORDER BY id`,
        [t],
      );
      assert.equal(rows.rows.length, 2);
      assert.deepEqual(rows.rows.map((row) => row.status).sort(), ["active", "archived"]);
      assert.equal(rows.rows.find((row) => row.id === old.id)?.reason, "expired-before-exact-dedupe-replacement");
    } finally {
      await pool.end();
    }
  }
});

test("hideExpiredOnRead=false preserves reinforcement semantics", { skip }, async () => {
  const visibleExpired = new PostgresMemoryProvider({
    connectionString: env.url,
    hideExpiredOnRead: false,
  });
  const service = new MemoryCoreService(visibleExpired);
  const t = tenant("expired_visible_dedupe");
  const old = record({
    tenantId: t,
    text: "Visible expired memory is still reinforced",
    decayPolicy: { kind: "time", ttlDays: 1 },
    createdAt: daysAgo(3),
    firstSeenAt: daysAgo(3),
    lastSeenAt: daysAgo(2),
    updatedAt: daysAgo(2),
  });
  try {
    await visibleExpired.ingest([old]);
    const result = await service.ingest({ observations: [{
      tenantId: t,
      appId: APP,
      actorId: old.actorId,
      scope: "actor",
      memoryType: "fact",
      text: old.text,
      decayPolicy: old.decayPolicy,
      source: { sourceType: "test", sourceId: "visible-expired-reinforcement" },
    }] });
    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.records[0]?.id, old.id);

    const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
    try {
      const stored = await pool.query<{ total: string; active: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE status = 'active')::text AS active
           FROM memories WHERE tenant_id = $1`,
        [t],
      );
      assert.equal(Number(stored.rows[0]?.total), 1);
      assert.equal(Number(stored.rows[0]?.active), 1);
    } finally {
      await pool.end();
    }
  } finally {
    await visibleExpired.close();
  }
});

test("direct duplicate writes surface only the named dedupe conflict", { skip }, async () => {
  const t = tenant("direct_dedupe_conflict");
  const first = record({ tenantId: t, text: "Direct writes still fail closed" });
  const second = record({ ...first, id: `${first.id}_other`, appId: "another_app" });
  await provider!.ingest([first]);
  await assert.rejects(
    () => provider!.ingest([second]),
    (error: unknown) => error instanceof MemoryDedupeConflictError &&
      error.indexName === "memories_active_actor_dedupe_uidx",
  );
});

test("a primary-key violation is never mislabeled as a dedupe conflict", { skip }, async () => {
  const first = record({ tenantId: tenant("pkey_not_dedupe"), text: "Original primary-key owner" });
  await provider!.ingest([first]);
  const collidingId = record({
    ...first,
    text: "Different text with the same opaque id",
    metadata: { collision: true },
  });
  await assert.rejects(
    () => provider!.ingestOrReinforceExact(collidingId),
    (error: unknown) => !(error instanceof MemoryDedupeConflictError)
      && (error as { code?: string }).code === "23505"
      && (error as { constraint?: string }).constraint === "memories_pkey",
  );
});

test("search respects every MemoryFilters field", { skip }, async () => {
  const t = tenant("filters");
  const spaceId = "platform-team";
  const base = { tenantId: t, spaceId, text: "quarterly infrastructure planning notes" };

  const actorA = record({ ...base, actorId: "actor_a", metadata: { region: "eu" } });
  const actorB = record({ ...base, actorId: "actor_b", metadata: { region: "us" } });
  const threaded = record({ ...base, actorId: "actor_a", threadId: "thread_x", scope: "thread" });
  const preference = record({ ...base, actorId: "actor_a", memoryType: "preference" });
  const workspace = record({ ...base, actorId: "actor_a", scope: "workspace" });
  await provider!.ingest([actorA, actorB, threaded, preference, workspace]);

  const all = await provider!.search({
    query: "quarterly infrastructure planning",
    filters: { tenantId: t, spaceId, appId: APP, actorId: "actor_a", accessThreadId: "thread_x" },
    limit: 50,
    minScore: 0,
  });
  assert.equal(all.length, 4);
  assert.ok(!ids(all).includes(actorB.id), "actor A must not see actor B's private memory");

  const byActor = await provider!.search({
    query: "quarterly infrastructure planning",
    filters: { tenantId: t, spaceId, appId: APP, actorId: "actor_b", scope: ["actor"] },
    limit: 50,
    minScore: 0,
  });
  assert.deepEqual(ids(byActor), [actorB.id]);

  const byThread = await provider!.search({
    query: "quarterly infrastructure planning",
    filters: { tenantId: t, spaceId, appId: APP, actorId: "actor_a", threadId: "thread_x" },
    limit: 50,
    minScore: 0,
  });
  assert.deepEqual(ids(byThread), [threaded.id]);

  const byType = await provider!.search({
    query: "quarterly infrastructure planning",
    filters: { tenantId: t, spaceId, appId: APP, actorId: "actor_a", memoryTypes: ["preference"] },
    limit: 50,
    minScore: 0,
  });
  assert.deepEqual(ids(byType), [preference.id]);

  const byScope = await provider!.search({
    query: "quarterly infrastructure planning",
    filters: { tenantId: t, spaceId, appId: APP, scope: ["workspace"] },
    limit: 50,
    minScore: 0,
  });
  assert.deepEqual(ids(byScope), [workspace.id]);

  const byMetadata = await provider!.search({
    query: "quarterly infrastructure planning",
    filters: { tenantId: t, spaceId, appId: APP, actorId: "actor_a", metadata: { region: "eu" } },
    limit: 50,
    minScore: 0,
  });
  assert.deepEqual(ids(byMetadata), [actorA.id]);

  const combined = await provider!.search({
    query: "quarterly infrastructure planning",
    filters: {
      tenantId: t,
      spaceId,
      appId: APP,
      actorId: "actor_a",
      accessThreadId: "thread_x",
      memoryTypes: ["fact"],
      scope: ["thread"],
    },
    limit: 50,
    minScore: 0,
  });
  assert.deepEqual(ids(combined), [threaded.id]);

  const noMatch = await provider!.search({
    query: "quarterly infrastructure planning",
    filters: { tenantId: t, spaceId, appId: APP, actorId: "actor_a", metadata: { region: "apac" } },
    limit: 50,
    minScore: 0,
  });
  assert.equal(noMatch.length, 0);
});

test("full-text ranking orders by ts_rank_cd and explains itself", { skip }, async () => {
  const t = tenant("fts");
  const strong = record({
    tenantId: t,
    text: "The incident retro covered the failed cache migration in detail",
    summary: "failed cache migration retro",
  });
  const weak = record({ tenantId: t, text: "The cache is warmed on boot" });
  await provider!.ingest([strong, weak]);

  const hits = await provider!.search({
    query: "failed cache migration retro",
    filters: { tenantId: t, appId: APP, actorId: "actor_1" },
    limit: 10,
    minScore: 0,
  });

  assert.equal(hits.length, 2);
  assert.equal(hits[0].memory.id, strong.id);
  assert.ok(hits[0].score > hits[1].score);
  assert.ok(
    hits[0].reasons.some((reason) => /lexical rank 1 \(ts_rank_cd/.test(reason)),
    `expected an explainable lexical reason, got ${JSON.stringify(hits[0].reasons)}`,
  );
});

test("tenant A never sees tenant B rows on any read path", { skip }, async () => {
  const a = tenant("iso_a");
  const b = tenant("iso_b");
  const shared = "identical wording stored under two different tenants";

  const rowA = record({ tenantId: a, actorId: "shared_actor", text: shared, threadId: "shared_thread" });
  const rowB = record({ tenantId: b, actorId: "shared_actor", text: shared, threadId: "shared_thread" });
  await provider!.ingest([rowA, rowB]);

  const searched = await provider!.search({
    query: "identical wording stored tenants",
    filters: { tenantId: a, appId: APP, actorId: "shared_actor" },
    limit: 50,
    minScore: 0,
  });
  assert.deepEqual(ids(searched), [rowA.id]);
  assert.ok(!ids(searched).includes(rowB.id), "tenant A search leaked a tenant B row");

  const listed = await provider!.listByActor(a, APP, "shared_actor");
  assert.deepEqual(listed.map((row) => row.id), [rowA.id]);

  const scoped = await provider!.getById(rowB.id, { tenantId: a, appId: APP, actorId: "shared_actor" });
  assert.equal(scoped, null, "scoped getById returned another tenant's row");

  const duplicate = await provider!.findDuplicate(record({ ...rowB, id: "candidate", tenantId: a }));
  assert.equal(duplicate?.id, rowA.id);

  const crossApp = await provider!.search({
    query: "identical wording stored tenants",
    filters: { tenantId: a, appId: "app_other", actorId: "shared_actor" },
    limit: 50,
    minScore: 0,
  });
  assert.deepEqual(ids(crossApp), [rowA.id], "actor memory should follow its actor across producer apps");
});

test("a cross-tenant id collision cannot transfer row ownership", { skip }, async () => {
  const a = tenant("takeover_a");
  const b = tenant("takeover_b");
  const victim = record({ tenantId: a, actorId: "victim_actor", text: "tenant A payroll export lives in bucket seven" });
  await provider!.ingest([victim]);

  // `memories.id` is a global primary key, so tenant B can guess or replay it.
  const attacker = record({ ...victim, tenantId: b, actorId: "attacker_actor", text: "tenant B benign note" });
  await assert.rejects(
    () => provider!.ingest([attacker]),
    /already exists under a different ownership scope/,
    "a cross-tenant id collision must be refused, not applied",
  );

  const stillMine = await provider!.getById(victim.id, { tenantId: a, appId: APP, actorId: "victim_actor" });
  assert.equal(stillMine?.tenantId, a, "the row was reassigned to another tenant");
  assert.equal(stillMine?.appId, APP);
  assert.equal(stillMine?.actorId, "victim_actor");
  assert.equal(stillMine?.text, victim.text, "the victim's content was overwritten");
  assert.deepEqual((await provider!.listByActor(a, APP, "victim_actor")).map((row) => row.id), [victim.id]);
  assert.equal((await provider!.listByActor(b, APP, "attacker_actor")).length, 0);
  assert.equal(await provider!.getById(victim.id, { tenantId: b, appId: APP, actorId: "attacker_actor" }), null);

  // Tenant and space alone are not ownership: an id cannot be repointed to a
  // different actor inside the same shared boundary.
  await assert.rejects(
    () => provider!.ingest([{ ...victim, actorId: "other_actor", text: "same-space actor takeover" }]),
    /already exists under a different ownership scope/,
  );

  // A different space in the same tenant is also a different trust boundary.
  await assert.rejects(
    () => provider!.ingest([record({ ...victim, spaceId: "other-space", text: "cross-space takeover" })]),
    /already exists under a different ownership scope/,
  );

  // The batch is one transaction, so a blocked row takes its siblings down with
  // it rather than half-applying the write.
  const sibling = record({ tenantId: b, actorId: "attacker_actor", text: "sibling row inside the blocked batch" });
  await assert.rejects(() => provider!.ingest([sibling, attacker]), /already exists/);
  assert.equal(await provider!.getById(sibling.id, { tenantId: b, appId: APP, actorId: "attacker_actor" }), null);
});

test("applyFeedback enforces tenant and app visibility for app-scoped memory", { skip }, async () => {
  const a = tenant("fbscope_a");
  const b = tenant("fbscope_b");
  const row = record({ tenantId: a, scope: "app", text: "scoped feedback target row" });
  await provider!.ingest([row]);

  assert.equal(
    await provider!.applyFeedback({ memoryId: row.id, signal: "positive", tenantId: b, appId: APP, actorId: "actor_1" }),
    null,
    "a mismatched tenant read back another tenant's row",
  );
  assert.equal(
    await provider!.applyFeedback({ memoryId: row.id, signal: "positive", tenantId: a, appId: "app_other", actorId: "actor_1" }),
    null,
    "a mismatched app read back another app's row",
  );

  const untouched = await provider!.getById(row.id, { tenantId: a, appId: APP, actorId: "actor_1" });
  assert.deepEqual(untouched?.stats, { selectedCount: 0, positiveCount: 0, negativeCount: 0 });
  assert.equal(new Date(untouched!.lastSeenAt).toISOString(), row.lastSeenAt, "a rejected signal still bumped the row");

  const scoped = await provider!.applyFeedback({ memoryId: row.id, signal: "positive", tenantId: a, appId: APP, actorId: "actor_1" });
  assert.equal(scoped?.stats.positiveCount, 1);
});

test("applyFeedback cannot revive an inactivity-expired memory", { skip }, async () => {
  const t = tenant("feedback_expired");
  const row = record({
    tenantId: t,
    text: "expired feedback must not refresh this row",
    decayPolicy: { kind: "inactivity", ttlDays: 1 },
    lastSeenAt: daysAgo(5),
  });
  await provider!.ingest([row]);

  const updated = await provider!.applyFeedback({
    memoryId: row.id,
    signal: "positive",
    tenantId: t,
    appId: APP,
    actorId: row.actorId,
  });
  assert.equal(updated, null);

  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  try {
    const stored = await pool.query<{ last_seen_at: Date; stats: Record<string, number> }>(
      "SELECT last_seen_at, stats FROM memories WHERE id = $1",
      [row.id],
    );
    assert.equal(stored.rows[0]?.last_seen_at.toISOString(), row.lastSeenAt);
    assert.equal(stored.rows[0]?.stats.positiveCount, 0);
  } finally {
    await pool.end();
  }
});

test("id-addressed reads and feedback enforce actor and thread visibility inside a space", { skip }, async () => {
  const t = tenant("idvisibility");
  const shared = { tenantId: t, spaceId: "platform-team", appId: APP };
  const actorRow = record({
    ...shared,
    actorId: "alice",
    scope: "actor",
    text: "Alice owns the private release signing policy",
  });
  const threadRow = record({
    ...shared,
    actorId: "alice",
    threadId: "release-42",
    scope: "thread",
    text: "This thread uses the temporary amber canary",
  });
  const workspaceRow = record({
    ...shared,
    actorId: "alice",
    scope: "workspace",
    text: "The platform workspace deploys from the main branch",
  });
  const personalRow = record({
    tenantId: t,
    appId: APP,
    actorId: "carol",
    scope: "actor",
    text: "Carol keeps this memory in her implicit personal space",
  });
  await provider!.ingest([actorRow, threadRow, workspaceRow, personalRow]);

  const alice = { ...shared, actorId: "alice", accessThreadId: "release-42" };
  const bob = { ...shared, actorId: "bob", accessThreadId: "release-99" };

  assert.ok(await provider!.getById(actorRow.id, alice));
  assert.equal(await provider!.getById(actorRow.id, bob), null);
  assert.equal(
    await provider!.applyFeedback({ memoryId: actorRow.id, signal: "negative", ...bob }),
    null,
  );

  assert.ok(await provider!.getById(threadRow.id, alice));
  assert.equal(await provider!.getById(threadRow.id, { ...alice, accessThreadId: "release-43" }), null);
  assert.equal(
    await provider!.applyFeedback({
      memoryId: threadRow.id,
      signal: "negative",
      ...alice,
      accessThreadId: "release-43",
    }),
    null,
  );

  assert.ok(await provider!.getById(workspaceRow.id, bob));
  const sharedFeedback = await provider!.applyFeedback({
    memoryId: workspaceRow.id,
    signal: "positive",
    ...bob,
  });
  assert.equal(sharedFeedback?.stats.positiveCount, 1);

  assert.ok(await provider!.getById(personalRow.id, {
    tenantId: t,
    appId: APP,
    actorId: "carol",
  }), "actorId should resolve an omitted personal space");
  assert.equal(await provider!.getById(personalRow.id, {
    tenantId: t,
    appId: APP,
    actorId: "dave",
  }), null);

  const untouchedActor = await provider!.getById(actorRow.id, alice);
  const untouchedThread = await provider!.getById(threadRow.id, alice);
  assert.equal(untouchedActor?.stats.negativeCount, 0);
  assert.equal(untouchedThread?.stats.negativeCount, 0);
});

test("retire atomically enforces id visibility and merges lifecycle metadata", { skip }, async () => {
  const t = tenant("retirescope");
  const shared = { tenantId: t, spaceId: "release-space", appId: APP };
  const row = record({
    ...shared,
    actorId: "alice",
    scope: "actor",
    text: "Alice's release review is scheduled for Tuesday",
    metadata: { retained: "yes" },
  });
  await provider!.ingest([row]);

  const bob = { ...shared, actorId: "bob" };
  assert.equal(
    await provider!.retire(row.id, "superseded", { supersededBy: "replacement" }, bob),
    null,
    "another actor must not retire a private id inside the same space",
  );
  assert.ok(await provider!.getById(row.id, { ...shared, actorId: "alice" }));

  const retired = await provider!.retire(
    row.id,
    "superseded",
    { supersededBy: "replacement", reason: "schedule changed" },
    { ...shared, actorId: "alice" },
  );
  assert.equal(retired?.status, "superseded");
  assert.equal(retired?.metadata.retained, "yes");
  assert.equal(retired?.metadata.supersededBy, "replacement");
  assert.equal(await provider!.getById(row.id, { ...shared, actorId: "alice" }), null);
  assert.equal(
    await provider!.retire(row.id, "archived", undefined, { ...shared, actorId: "alice" }),
    null,
    "retirement must be one-way and idempotent for an already inactive row",
  );
});

test("requireIdScope refuses unscoped getById and applyFeedback", { skip }, async () => {
  const t = tenant("strictscope");
  const row = record({ tenantId: t, text: "strict scope target row" });
  await provider!.ingest([row]);

  const strict = new PostgresMemoryProvider({ connectionString: env.url, poolMax: 2, requireIdScope: true });
  try {
    await assert.rejects(() => strict.getById(row.id), /getById requires tenantId plus spaceId or actorId/);
    await assert.rejects(
      () => strict.applyFeedback({ memoryId: row.id, signal: "positive" }),
      /applyFeedback requires tenantId plus spaceId or actorId/,
    );

    assert.ok(await strict.getById(row.id, { tenantId: t, appId: APP, actorId: "actor_1" }));
    const fed = await strict.applyFeedback({ memoryId: row.id, signal: "positive", tenantId: t, appId: APP, actorId: "actor_1" });
    assert.equal(fed?.stats.positiveCount, 1);
  } finally {
    await strict.close();
  }
});

test("re-ingest preserves accumulated feedback counters", { skip }, async () => {
  const t = tenant("statsmerge");
  const row = record({ tenantId: t, text: "counter accumulation survives re-ingest" });
  await provider!.ingest([row]);

  for (const signal of ["selected", "selected", "positive", "negative"] as const) {
    await provider!.applyFeedback({ memoryId: row.id, signal, tenantId: t, appId: APP, actorId: "actor_1" });
  }

  // The incoming record carries default zeroed stats, as any re-ingest of an
  // observation would; the accumulated learning signal must survive it.
  const revised = await provider!.update({
    ...row,
    text: "counter accumulation, revised",
    stats: { selectedCount: 0, positiveCount: 0, negativeCount: 0 },
  });
  assert.equal(revised.text, "counter accumulation, revised", "the upsert stopped refreshing mutable fields");
  assert.deepEqual(revised.stats, { selectedCount: 2, positiveCount: 1, negativeCount: 1 });

  // Max-merge, not preserve-existing: a replay or backfill can still push a
  // counter up, it just cannot walk one back.
  const backfilled = await provider!.update({
    ...row,
    stats: { selectedCount: 9, positiveCount: 0, negativeCount: 0, accessCount: 4 },
  });
  assert.deepEqual(backfilled.stats, { selectedCount: 9, positiveCount: 1, negativeCount: 1, accessCount: 4 });

  const fetched = await provider!.getById(row.id, { tenantId: t, appId: APP, actorId: "actor_1" });
  assert.deepEqual(fetched?.stats, { selectedCount: 9, positiveCount: 1, negativeCount: 1, accessCount: 4 });
});

test("concurrent batches sharing ids in opposite orders do not deadlock", { skip }, async () => {
  const t = tenant("lockorder");
  const batch = Array.from({ length: 24 }, (_, index) =>
    record({ tenantId: t, actorId: "actor_lock", text: `lock order probe ${index}` }),
  );
  const reversed = [...batch].reverse();

  for (let round = 0; round < 8; round += 1) {
    const settled = await Promise.allSettled([
      provider!.ingest(batch),
      provider!.ingest(reversed),
      provider!.ingest(reversed),
      provider!.ingest(batch),
    ]);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason?.message ?? result.reason));
    assert.deepEqual(failures, [], `round ${round} lost an ingest`);
  }
  assert.equal((await provider!.listByActor(t, APP, "actor_lock")).length, 24);

  // A repeated id inside one batch collapses to the last write instead of
  // tripping ON CONFLICT's one-row-once rule.
  const first = record({ tenantId: t, actorId: "actor_dup", text: "first write in the batch" });
  const saved = await provider!.ingest([first, { ...first, text: "last write in the batch wins" }]);
  assert.equal(saved.length, 2);
  assert.deepEqual(
    saved.map((memory) => memory.text),
    ["last write in the batch wins", "last write in the batch wins"],
  );
  const stored = await provider!.getById(first.id, { tenantId: t, appId: APP, actorId: "actor_dup" });
  assert.equal(stored?.text, "last write in the batch wins");
});

test("applyFeedback increments stats atomically under concurrency", { skip }, async () => {
  const t = tenant("feedback");
  const row = record({ tenantId: t, text: "feedback target row" });
  await provider!.ingest([row]);

  const selected = await provider!.applyFeedback({ memoryId: row.id, signal: "selected" });
  assert.equal(selected?.stats.selectedCount, 1);
  const negative = await provider!.applyFeedback({ memoryId: row.id, signal: "negative" });
  assert.equal(negative?.stats.negativeCount, 1);
  assert.equal(negative?.stats.selectedCount, 1);

  await Promise.all(
    Array.from({ length: 20 }, () => provider!.applyFeedback({ memoryId: row.id, signal: "positive" })),
  );

  const final = await provider!.getById(row.id, { tenantId: t, appId: APP, actorId: "actor_1" });
  assert.equal(final?.stats.positiveCount, 20, "concurrent increments lost an update");
  assert.equal(final?.stats.selectedCount, 1);
  assert.equal(final?.stats.negativeCount, 1);

  assert.equal(await provider!.applyFeedback({ memoryId: "mem_does_not_exist", signal: "positive" }), null);
});

test("compact archives decayed and superseded rows and returns real counts", { skip }, async () => {
  const t = tenant("decay");

  const timeExpired = record({
    tenantId: t,
    text: "time-decayed row",
    decayPolicy: { kind: "time", ttlDays: 1 },
    createdAt: daysAgo(5),
    firstSeenAt: daysAgo(5),
    lastSeenAt: new Date().toISOString(),
  });
  const inactivityExpired = record({
    tenantId: t,
    text: "inactivity-decayed row",
    decayPolicy: { kind: "inactivity", ttlDays: 1 },
    createdAt: new Date().toISOString(),
    lastSeenAt: daysAgo(5),
  });
  const timeFresh = record({
    tenantId: t,
    text: "time policy still inside its window",
    decayPolicy: { kind: "time", ttlDays: 30 },
    createdAt: daysAgo(5),
  });
  const never = record({ tenantId: t, text: "never decays", decayPolicy: { kind: "none" }, createdAt: daysAgo(900) });
  const malformed = record({
    tenantId: t,
    text: "malformed ttl must not error",
    decayPolicy: { kind: "time", ttlDays: "banana" as unknown as number },
    createdAt: daysAgo(5),
  });
  const superseded = record({ tenantId: t, text: "superseded row", status: "superseded" });

  await provider!.ingest([timeExpired, inactivityExpired, timeFresh, never, malformed, superseded]);

  // hideExpiredOnRead keeps decayed rows out of reads before compaction runs.
  assert.equal(await provider!.getById(timeExpired.id, { tenantId: t, appId: APP, actorId: "actor_1" }), null);
  assert.equal(await provider!.getById(inactivityExpired.id, { tenantId: t, appId: APP, actorId: "actor_1" }), null);
  assert.ok(await provider!.getById(timeFresh.id, { tenantId: t, appId: APP, actorId: "actor_1" }));
  assert.ok(await provider!.getById(never.id, { tenantId: t, appId: APP, actorId: "actor_1" }));
  assert.ok(await provider!.getById(malformed.id, { tenantId: t, appId: APP, actorId: "actor_1" }), "malformed ttlDays fell back to 180d");

  const result = await provider!.compact();
  // compact() is a global maintenance sweep, so other tenants can contribute.
  assert.ok(result.archivedExpired >= 2, `expected >= 2 expired, got ${result.archivedExpired}`);
  assert.ok(result.archivedSuperseded >= 1, `expected >= 1 superseded, got ${result.archivedSuperseded}`);

  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  try {
    const statuses = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM memories WHERE tenant_id = $1 ORDER BY id",
      [t],
    );
    const byId = new Map(statuses.rows.map((row) => [row.id, row.status]));
    assert.equal(byId.get(timeExpired.id), "archived");
    assert.equal(byId.get(inactivityExpired.id), "archived");
    assert.equal(byId.get(superseded.id), "archived");
    assert.equal(byId.get(timeFresh.id), "active");
    assert.equal(byId.get(never.id), "active");
    assert.equal(byId.get(malformed.id), "active");
  } finally {
    await pool.end();
  }

  const second = await provider!.compact();
  assert.equal(second.archivedSuperseded, 0, "compact should be idempotent for superseded rows");
});

// ---------------------------------------------------------------------------
// Vector / hybrid tests. The preflight explicitly provisions 8 dimensions;
// request paths must never create or alter vector tables on demand.
// ---------------------------------------------------------------------------

const QUERY = "how do I roll back a broken deployment";

// Shares only "deployment" with the query, so it loses on lexical rank.
const SEMANTIC_TARGET = "prefer the blue-green switch for any risky deployment";
// Shares every query term but is about something else entirely.
const LEXICAL_DISTRACTOR = "roll back the broken deployment of the parade float";
// Share no query terms; they exist to push the distractor down the vector list.
const FILLERS = [
  "the kitchen inventory was counted on tuesday",
  "annual photography permits renew in march",
  "the north bicycle rack needs repainting",
  "sourdough starters live in the second fridge",
  "quarterly ukulele lessons moved to room four",
  "the greenhouse thermostat reads two degrees high",
  "library due dates shifted by one week",
];

const FIXTURE_VECTORS = new Map<string, number[]>([
  [QUERY, atCosine(1)],
  [SEMANTIC_TARGET, atCosine(0.99)],
  [LEXICAL_DISTRACTOR, atCosine(0.1)],
  ...FILLERS.map((text, index) => [text, atCosine(0.98 - index * 0.01)] as [string, number[]]),
]);

test("hybrid RRF lets vector proximity overturn lexical-only ranking", { skip: skipVector }, async () => {
  const t = tenant("hybrid");
  const rows = [SEMANTIC_TARGET, LEXICAL_DISTRACTOR, ...FILLERS].map((text) =>
    record({ tenantId: t, actorId: "actor_hybrid", text, lastSeenAt: daysAgo(1), createdAt: daysAgo(1) }),
  );
  const targetId = rows[0].id;
  const distractorId = rows[1].id;

  const embedder = new FixtureEmbedder(8, FIXTURE_VECTORS);
  const hybrid = new PostgresMemoryProvider({
    connectionString: env.url,
    poolMax: 4,
    embedder,
    embeddingModel: "fixture-8d",
  });

  try {
    await hybrid.ingest(rows);

    // Lexical only: the distractor shares every query term, so it wins.
    const lexicalOnly = await provider!.search({
      query: QUERY,
      filters: { tenantId: t, appId: APP, actorId: "actor_hybrid" },
      limit: 10,
      minScore: 0,
    });
    const lexicalOrder = ids(lexicalOnly);
    assert.equal(lexicalOrder[0], distractorId, `lexical-only order was ${JSON.stringify(lexicalOrder)}`);
    assert.ok(
      lexicalOrder.indexOf(distractorId) < lexicalOrder.indexOf(targetId),
      "expected the distractor to beat the target without an embedder",
    );

    // Hybrid: the target is vector rank 1 while the distractor sits at vector
    // rank 9, and RRF flips the ordering.
    const fused = await hybrid.search({
      query: QUERY,
      filters: { tenantId: t, appId: APP, actorId: "actor_hybrid" },
      limit: 10,
      minScore: 0,
    });
    const fusedOrder = ids(fused);
    assert.equal(fusedOrder[0], targetId, `hybrid order was ${JSON.stringify(fusedOrder)}`);
    assert.ok(
      fusedOrder.indexOf(targetId) < fusedOrder.indexOf(distractorId),
      "hybrid fusion failed to promote the vector-close row",
    );

    const winner = fused[0];
    assert.ok(
      winner.reasons.some((reason) => /vector rank 1 \(cosine similarity/.test(reason)),
      `expected a vector reason, got ${JSON.stringify(winner.reasons)}`,
    );
    assert.ok(
      winner.reasons.some((reason) => /both rankers agreed \(rrf/.test(reason)),
      `expected a fusion reason, got ${JSON.stringify(winner.reasons)}`,
    );

    console.log(
      `[hybrid] lexical-only top=${lexicalOnly[0].memory.text.slice(0, 40)}... ` +
        `score=${lexicalOnly[0].score.toFixed(4)}`,
    );
    console.log(`[hybrid] fused top=${winner.memory.text.slice(0, 40)}... score=${winner.score.toFixed(4)}`);
    console.log(`[hybrid] fused reasons=${JSON.stringify(winner.reasons)}`);
  } finally {
    await hybrid.close();
  }
});

test("vector recall finds rows with no lexical overlap at all", { skip: skipVector }, async () => {
  const t = tenant("vectoronly");
  const row = record({ tenantId: t, actorId: "actor_vec", text: SEMANTIC_TARGET });

  const hybrid = new PostgresMemoryProvider({
    connectionString: env.url,
    poolMax: 2,
    embedder: new FixtureEmbedder(8, FIXTURE_VECTORS),
    embeddingModel: "fixture-8d",
  });

  try {
    await hybrid.ingest([row]);

    // The filler text shares no lexemes with the stored row, so any hit here
    // has to come from the vector CTE.
    const hits = await hybrid.search({
      query: FILLERS[0],
      filters: { tenantId: t, appId: APP, actorId: "actor_vec" },
      limit: 5,
      minScore: 0,
    });
    assert.deepEqual(ids(hits), [row.id]);
    assert.ok(
      hits[0].reasons.some((reason) => /vector-only match/.test(reason)),
      `expected a vector-only reason, got ${JSON.stringify(hits[0].reasons)}`,
    );
  } finally {
    await hybrid.close();
  }
});

test("vector search excludes rows embedded by a different model in the same dimension", { skip: skipVector }, async () => {
  const t = tenant("vectormodel");
  const row = record({ tenantId: t, actorId: "actor_model", text: SEMANTIC_TARGET });
  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  const hybrid = new PostgresMemoryProvider({
    connectionString: env.url,
    poolMax: 2,
    embedder: new FixtureEmbedder(8, FIXTURE_VECTORS),
    embeddingModel: "fixture-current",
  });
  try {
    await hybrid.ingest([row]);
    await pool.query("UPDATE memory_embeddings_8 SET model = 'fixture-retired' WHERE memory_id = $1", [row.id]);
    const hits = await hybrid.search({
      query: FILLERS[0],
      filters: { tenantId: t, appId: APP, actorId: "actor_model" },
      limit: 5,
      minScore: 0,
    });
    assert.deepEqual(ids(hits), [], "incompatible model coordinates must not enter vector fusion");
  } finally {
    await hybrid.close();
    await pool.end();
  }
});

test("a blocked cross-tenant collision leaves the victim's vector row intact", { skip: skipVector }, async () => {
  const a = tenant("vectakeover_a");
  const b = tenant("vectakeover_b");
  const victim = record({ tenantId: a, actorId: "actor_vec_a", text: SEMANTIC_TARGET });

  const hybrid = new PostgresMemoryProvider({
    connectionString: env.url,
    poolMax: 2,
    embedder: new FixtureEmbedder(8, FIXTURE_VECTORS),
    embeddingModel: "fixture-8d",
  });
  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  const probe = "SELECT tenant_id, app_id, embedding::text AS embedding FROM memory_embeddings_8 WHERE memory_id = $1";

  try {
    await hybrid.ingest([victim]);
    const before = await pool.query<{ tenant_id: string; app_id: string; embedding: string }>(probe, [victim.id]);
    assert.equal(before.rows[0]?.tenant_id, a);

    await assert.rejects(
      () => hybrid.ingest([{ ...victim, tenantId: b, actorId: "actor_vec_b", text: LEXICAL_DISTRACTOR }]),
      /already exists under a different ownership scope/,
    );

    const after = await pool.query<{ tenant_id: string; app_id: string; embedding: string }>(probe, [victim.id]);
    assert.deepEqual(after.rows[0], before.rows[0], "the victim's embedding row was reassigned or repointed");
  } finally {
    await pool.end();
    await hybrid.close();
  }
});

test("a hosted embedding outage degrades search to lexical retrieval with a cooldown", { skip: skipVector }, async () => {
  const t = tenant("vectorfallback");
  const row = record({ tenantId: t, actorId: "actor_fallback", text: "the release gateway uses a blue canary" });
  await provider!.ingest([row]);
  let embedCalls = 0;
  const hybrid = new PostgresMemoryProvider({
    connectionString: env.url,
    poolMax: 2,
    embedderCooldownMs: 60_000,
    embedder: {
      dims: 8,
      async embed() {
        embedCalls += 1;
        throw new Error("simulated hosted embedding outage");
      },
    },
  });
  try {
    const query = {
      query: "release gateway blue canary",
      filters: { tenantId: t, appId: APP, actorId: "actor_fallback" },
      minScore: 0,
    };
    assert.deepEqual(ids(await hybrid.search(query)), [row.id]);
    assert.deepEqual(ids(await hybrid.search(query)), [row.id]);
    assert.equal(embedCalls, 1, "the cooldown must prevent an upstream call on every search");
  } finally {
    await hybrid.close();
  }
});

test("search never provisions a missing embedding dimension on its request path", { skip: skipVector }, async () => {
  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  const t = tenant("noddlsearch");
  const row = record({ tenantId: t, actorId: "actor_noddl", text: "lexical fallback remains available" });
  await provider!.ingest([row]);
  const unprovisionedDims = 15_997;
  const before = await pool.query<{ relation: string | null }>(
    `SELECT to_regclass('memory_embeddings_${unprovisionedDims}')::text AS relation`,
  );
  assert.equal(before.rows[0]?.relation, null, "fixture dimension unexpectedly exists; choose another test dimension");
  const hybrid = new PostgresMemoryProvider({
    connectionString: env.url,
    poolMax: 2,
    embedder: {
      dims: unprovisionedDims,
      async embed() {
        throw new Error("embed should not run before provisioning is verified");
      },
    },
  });
  try {
    assert.deepEqual(ids(await hybrid.search({
      query: "lexical fallback available",
      filters: { tenantId: t, appId: APP, actorId: "actor_noddl" },
      minScore: 0,
    })), [row.id]);
    const relation = await pool.query<{ relation: string | null }>(
      `SELECT to_regclass('memory_embeddings_${unprovisionedDims}')::text AS relation`,
    );
    assert.equal(relation.rows[0]?.relation, null);
  } finally {
    await hybrid.close();
    await pool.end();
  }
});

test("embedding tables are provisioned per dimension with an HNSW index", { skip: skipVector }, async () => {
  const pool = new Pool({ connectionString: env.url, max: 1, allowExitOnIdle: true });
  try {
    const table = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'memory_embeddings_8'",
    );
    assert.ok(table.rowCount && table.rowCount > 0, "memory_embeddings_8 was not provisioned on demand");

    const index = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'memory_embeddings_8' AND indexname LIKE '%hnsw%'",
    );
    assert.equal(index.rowCount, 1, "expected exactly one HNSW index");
    assert.match(index.rows[0].indexdef, /USING hnsw/);
    assert.match(index.rows[0].indexdef, /vector_cosine_ops/);

    const defaultTable = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'memory_embeddings_384'",
    );
    assert.ok(defaultTable.rowCount && defaultTable.rowCount > 0, "default 384-dim table missing");
  } finally {
    await pool.end();
  }
});

test("an embedder without pgvector produces an actionable error", { skip }, async () => {
  if (env.vectorVersion) return; // Covered by the vector tests above.
  const broken = new PostgresMemoryProvider({
    connectionString: env.url,
    embedder: new FixtureEmbedder(8, FIXTURE_VECTORS),
  });
  try {
    await assert.rejects(
      () => broken.ingest([record({ tenantId: tenant("novector"), text: SEMANTIC_TARGET })]),
      /pgvector extension is not installed/,
    );
  } finally {
    await broken.close();
  }
});
