import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Pool as PgPool, PoolClient } from "pg";
import type { MemoryProvider, ProviderHealthStatus } from "../provider.js";
import type {
  DecayPolicy,
  MemoryCompactResult,
  MemoryFeedbackInput,
  MemoryFeedbackStats,
  MemoryFilters,
  MemoryRecord,
  MemoryScope,
  MemorySearchHit,
  MemorySearchQuery,
  MemorySource,
  MemoryStatus,
  MemoryType,
} from "../types.js";

const { Pool } = pg;

/**
 * Structural shape of `src/retrieval`'s EmbeddingProvider. Declared locally so
 * this module stays decoupled from that package; any object with these members
 * is accepted.
 */
export interface EmbeddingProviderLike {
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface PostgresProviderOptions {
  /** Defaults to DATABASE_URL, MEMORY_PG_URL, then a localhost dev database. */
  connectionString?: string;
  /** Reuse an existing pool. Caller-owned pools are not ended by close(). */
  pool?: PgPool;
  poolMax?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** When set, ingest/update store vectors and search fuses them with FTS. */
  embedder?: EmbeddingProviderLike | null;
  /** Label stored next to each vector so re-embedding runs are identifiable. */
  embeddingModel?: string;
  embedOnIngest?: boolean;
  /** RRF rank constant. Larger values flatten the advantage of the top ranks. */
  rrfK?: number;
  lexicalWeight?: number;
  vectorWeight?: number;
  /** Candidates pulled per ranker, as a multiple of the requested limit. */
  candidateMultiplier?: number;
  /** Filter decay-expired rows out of reads instead of waiting for compact(). */
  hideExpiredOnRead?: boolean;
  /** Safety cap on the otherwise unbounded listByActor interface. */
  maxListRows?: number;
  /** Fail closed on the two id-keyed paths (getById, applyFeedback) when the
   *  caller supplies no tenant/app. Off by default: MemoryProvider declares both
   *  without a tenant, so requiring one breaks interface callers. */
  requireIdScope?: boolean;
  autoMigrate?: boolean;
  migrationFile?: string;
}

export const DEFAULT_PG_URL = "postgres://madhavgoyal@localhost:5432/memory_core_dev";

const MEMORY_COLUMNS = [
  "id",
  "tenant_id",
  "app_id",
  "actor_id",
  "thread_id",
  "scope",
  "memory_type",
  "text",
  "summary",
  "metadata",
  "confidence",
  "importance",
  "status",
  "source",
  "decay_policy",
  "first_seen_at",
  "last_seen_at",
  "created_at",
  "updated_at",
  "stats",
] as const;

const FEEDBACK_KEYS: Record<MemoryFeedbackInput["signal"], keyof MemoryFeedbackStats> = {
  selected: "selectedCount",
  positive: "positiveCount",
  negative: "negativeCount",
};

/** Derived from FEEDBACK_KEYS so a new signal cannot be merged inconsistently. */
const COUNTER_KEYS = Object.values(FEEDBACK_KEYS);

const RECENCY_HALF_LIFE_DAYS = 30;
const LN2 = 0.6931471805599453;
const MAX_CANDIDATES = 1_000;

interface MemoryRow {
  id: string;
  tenant_id: string;
  app_id: string;
  actor_id: string;
  thread_id: string | null;
  scope: MemoryScope;
  memory_type: MemoryType;
  text: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  source: MemorySource | null;
  decay_policy: DecayPolicy | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  stats: Partial<MemoryFeedbackStats> | null;
}

interface ScoredRow extends MemoryRow {
  score: number;
  recency: number;
  feedback: number;
  relevance?: number;
  rrf?: number;
  lex_raw?: number | null;
  lex_rnk?: string | number | null;
  vec_raw?: number | null;
  vec_rnk?: string | number | null;
}

interface VectorTarget {
  table: string;
  dims: number;
  /** Cosine distance expression, switching to halfvec above the HNSW dim cap. */
  distance: (column: string, queryRef: string) => string;
}

/** Accumulates bind values so no caller-supplied value is ever interpolated. */
class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function columnList(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return MEMORY_COLUMNS.map((column) => `${prefix}${column}`).join(", ");
}

function assertScope(tenantId: string | undefined, appId: string | undefined, where: string): void {
  if (!tenantId || !appId) {
    throw new Error(`postgres-provider: ${where} requires both tenantId and appId (refusing an unscoped query)`);
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapRow(row: MemoryRow): MemoryRecord {
  const stats = row.stats || {};
  return {
    id: row.id,
    tenantId: row.tenant_id,
    appId: row.app_id,
    actorId: row.actor_id,
    threadId: row.thread_id,
    scope: row.scope,
    memoryType: row.memory_type,
    text: row.text,
    summary: row.summary,
    metadata: row.metadata || {},
    confidence: toNumber(row.confidence),
    importance: toNumber(row.importance),
    status: row.status,
    source: (row.source || { sourceType: "unknown" }) as MemorySource,
    decayPolicy: (row.decay_policy || { kind: "none" }) as DecayPolicy,
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    stats: {
      selectedCount: toNumber(stats.selectedCount),
      positiveCount: toNumber(stats.positiveCount),
      negativeCount: toNumber(stats.negativeCount),
      ...(stats.accessCount === undefined ? {} : { accessCount: toNumber(stats.accessCount) }),
    },
  };
}

function toVectorLiteral(embedding: Float32Array, dims: number): string {
  if (embedding.length !== dims) {
    throw new Error(`postgres-provider: embedder returned ${embedding.length} dims but declares ${dims}`);
  }
  const parts = new Array<string>(dims);
  for (let i = 0; i < dims; i += 1) {
    const value = embedding[i];
    if (!Number.isFinite(value)) {
      throw new Error("postgres-provider: embedding contains a non-finite value");
    }
    parts[i] = String(value);
  }
  return `[${parts.join(",")}]`;
}

/** The regex guard keeps a malformed ttlDays from throwing on cast; CASE is one
 *  of the few PostgreSQL constructs with guaranteed short-circuit evaluation. */
function ttlDaysSql(alias: string): string {
  return `(CASE WHEN (${alias}.decay_policy ->> 'ttlDays') ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (${alias}.decay_policy ->> 'ttlDays')::numeric
                ELSE 180 END)`;
}

/** `time` measures age from creation, `inactivity` from the last sighting. */
function decayAnchorSql(alias: string): string {
  return `(CASE WHEN (${alias}.decay_policy ->> 'kind') = 'inactivity'
                THEN ${alias}.last_seen_at
                ELSE ${alias}.created_at END)`;
}

function expiredSql(alias: string): string {
  return `((${alias}.decay_policy ->> 'kind') IN ('time', 'inactivity')
           AND ${ttlDaysSql(alias)} > 0
           AND ${decayAnchorSql(alias)} < now() - ${ttlDaysSql(alias)} * interval '1 day')`;
}

function statNumberSql(alias: string, key: string): string {
  return `(CASE WHEN jsonb_typeof(${alias}.stats -> '${key}') = 'number'
                THEN (${alias}.stats ->> '${key}')::float8
                ELSE 0::float8 END)`;
}

/** Floored integer read of a stats counter; absent or non-numeric reads as 0. */
function statCountSql(alias: string, key: string): string {
  return `(CASE WHEN jsonb_typeof(${alias}.stats -> '${key}') = 'number'
                THEN floor((${alias}.stats ->> '${key}')::numeric)
                ELSE 0::numeric END)`;
}

function statsObjectSql(alias: string): string {
  return `(CASE WHEN jsonb_typeof(${alias}.stats) = 'object' THEN ${alias}.stats ELSE '{}'::jsonb END)`;
}

/** Re-ingest must not roll back counters accumulated by applyFeedback, so every
 *  counter keeps the larger of stored and incoming. Max rather than
 *  preserve-existing so a replay or backfill can still push a counter up.
 *  accessCount is optional, so it is only emitted when one side carries it. */
function mergeStatsSql(): string {
  const stored = statsObjectSql("memories");
  const incoming = statsObjectSql("excluded");
  const counters = COUNTER_KEYS.map(
    (key) => `'${key}', GREATEST(${statCountSql("memories", key)}, ${statCountSql("excluded", key)})`,
  ).join(", ");
  return `((${stored} || ${incoming})
           || jsonb_build_object(${counters})
           || (CASE WHEN (${stored} ? 'accessCount') OR (${incoming} ? 'accessCount')
                    THEN jsonb_build_object('accessCount',
                           GREATEST(${statCountSql("memories", "accessCount")}, ${statCountSql("excluded", "accessCount")}))
                    ELSE '{}'::jsonb END))`;
}

/**
 * Sorts by id and collapses repeats (last write wins) so concurrent batches that
 * share ids always take row locks in the same order. Unordered batches deadlock
 * against each other, and a repeated id trips ON CONFLICT's one-row-once rule.
 */
function orderForLocking(records: MemoryRecord[]): MemoryRecord[] {
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const deduped: MemoryRecord[] = [];
  for (const record of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].id === record.id) deduped[deduped.length - 1] = record;
    else deduped.push(record);
  }
  return deduped;
}

function recencySql(alias: string): string {
  return `exp(-${LN2} * GREATEST(EXTRACT(EPOCH FROM (now() - ${alias}.last_seen_at))::float8, 0::float8)
              / 86400.0 / ${RECENCY_HALF_LIFE_DAYS}.0)`;
}

function feedbackSql(alias: string): string {
  const delta = `(${statNumberSql(alias, "positiveCount")} - ${statNumberSql(alias, "negativeCount")})`;
  return `GREATEST(LEAST(${delta} * 0.02, 0.12), -0.12)`;
}

function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "42883";
}

export class PostgresMemoryProvider implements MemoryProvider {
  private readonly pool: PgPool;
  private readonly ownsPool: boolean;
  private readonly embedder: EmbeddingProviderLike | null;
  private readonly embeddingModel: string;
  private readonly embedOnIngest: boolean;
  private readonly rrfK: number;
  private readonly lexicalWeight: number;
  private readonly vectorWeight: number;
  private readonly candidateMultiplier: number;
  private readonly hideExpiredOnRead: boolean;
  private readonly maxListRows: number;
  private readonly requireIdScope: boolean;
  private readonly autoMigrate: boolean;
  private readonly migrationFile: string;

  private migratePromise: Promise<void> | null = null;
  private vectorPromise: Promise<VectorTarget> | null = null;
  private closed = false;

  constructor(options: PostgresProviderOptions = {}) {
    const connectionString =
      options.connectionString || process.env.DATABASE_URL || process.env.MEMORY_PG_URL || DEFAULT_PG_URL;

    // Sent as a startup parameter rather than a per-connection SET, so no extra
    // round trip and no query racing pg's own connect handling.
    const statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
    const startupOptions =
      Number.isInteger(statementTimeoutMs) && statementTimeoutMs > 0
        ? `-c statement_timeout=${statementTimeoutMs}`
        : undefined;

    this.ownsPool = !options.pool;
    this.pool =
      options.pool ||
      new Pool({
        connectionString,
        options: startupOptions,
        max: options.poolMax ?? 10,
        connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
        idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
        allowExitOnIdle: true,
      });

    // Without a listener an idle-client failure is an unhandled 'error' event.
    this.pool.on("error", () => {});

    this.embedder = options.embedder ?? null;
    this.embeddingModel = options.embeddingModel || "unspecified";
    this.embedOnIngest = options.embedOnIngest ?? true;
    this.rrfK = options.rrfK ?? 60;
    this.lexicalWeight = options.lexicalWeight ?? 1;
    this.vectorWeight = options.vectorWeight ?? 1;
    this.candidateMultiplier = Math.max(options.candidateMultiplier ?? 8, 1);
    this.hideExpiredOnRead = options.hideExpiredOnRead ?? true;
    this.maxListRows = options.maxListRows ?? 1_000;
    this.requireIdScope = options.requireIdScope ?? false;
    this.autoMigrate = options.autoMigrate ?? false;
    this.migrationFile =
      options.migrationFile || fileURLToPath(new URL("../../migrations/001_init.sql", import.meta.url));
  }

  // -- lifecycle ------------------------------------------------------------

  /** Applies migrations/001_init.sql. Idempotent and safe to call repeatedly. */
  async migrate(): Promise<void> {
    if (!this.migratePromise) {
      this.migratePromise = (async () => {
        const sql = await readFile(this.migrationFile, "utf8");
        await this.pool.query(sql);
      })().catch((error) => {
        this.migratePromise = null;
        throw error;
      });
    }
    return this.migratePromise;
  }

  /** Ends the pool. No timers are registered, so nothing else holds the loop. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await this.pool.end();
  }

  private async ready(): Promise<void> {
    if (this.autoMigrate) await this.migrate();
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // -- vector plumbing ------------------------------------------------------

  private async resolveVectorTarget(): Promise<VectorTarget> {
    const dims = this.embedder?.dims;
    if (!Number.isInteger(dims) || (dims as number) < 1 || (dims as number) > 16_000) {
      throw new Error(`postgres-provider: embedder.dims must be an integer in 1..16000, got ${String(dims)}`);
    }
    const width = dims as number;

    const extension = await this.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    if (extension.rowCount === 0) {
      const database = await this.pool.query<{ db: string }>("SELECT current_database() AS db");
      throw new Error(
        `postgres-provider: an embedder is configured but the pgvector extension is not installed in database ` +
          `"${database.rows[0]?.db}". Install pgvector for this server, then run: CREATE EXTENSION vector;`,
      );
    }

    let table: string;
    try {
      const created = await this.pool.query<{ table_name: string }>(
        "SELECT memory_core_ensure_embedding_dim($1) AS table_name",
        [width],
      );
      table = created.rows[0]?.table_name ?? "";
    } catch (error) {
      if (isMissingRelation(error)) {
        throw new Error(
          "postgres-provider: memory_core_ensure_embedding_dim() is missing. Apply migrations/001_init.sql " +
            "(or construct the provider with autoMigrate: true).",
        );
      }
      throw error;
    }

    // Always an integer-suffixed name generated by the migration, but it reaches
    // SQL by interpolation so it is validated regardless.
    if (!/^memory_embeddings_\d+$/.test(table)) {
      throw new Error(`postgres-provider: unexpected embedding table name "${table}"`);
    }

    // HNSW over `vector` is capped at 2000 dims, so wider models are indexed
    // and queried through the halfvec cast instead.
    const distance =
      width <= 2000
        ? (column: string, queryRef: string) => `${column} <=> ${queryRef}::vector(${width})`
        : (column: string, queryRef: string) =>
            `(${column})::halfvec(${width}) <=> ${queryRef}::halfvec(${width})`;

    return { table, dims: width, distance };
  }

  private async vectorTarget(): Promise<VectorTarget | null> {
    if (!this.embedder) return null;
    if (!this.vectorPromise) {
      this.vectorPromise = this.resolveVectorTarget().catch((error) => {
        this.vectorPromise = null;
        throw error;
      });
    }
    return this.vectorPromise;
  }

  private async embedTexts(texts: string[]): Promise<Float32Array[]> {
    if (!this.embedder) return [];
    const vectors = await this.embedder.embed(texts);
    if (vectors.length !== texts.length) {
      throw new Error(`postgres-provider: embedder returned ${vectors.length} vectors for ${texts.length} texts`);
    }
    return vectors;
  }

  /**
   * Resolves the vector table and computes literals *before* a transaction is
   * opened. Provisioning a new dimension needs a lock on `memories` that our own
   * open transaction would block, and the embedder may be a slow network call
   * that has no business holding a transaction open.
   */
  private async prepareEmbeddings(
    records: MemoryRecord[],
  ): Promise<{ target: VectorTarget; literals: Map<string, string> } | null> {
    if (!this.embedder || !this.embedOnIngest || records.length === 0) return null;
    const target = await this.vectorTarget();
    if (!target) return null;

    const vectors = await this.embedTexts(records.map((record) => record.text));
    const literals = new Map<string, string>();
    records.forEach((record, index) => {
      literals.set(record.id, toVectorLiteral(vectors[index], target.dims));
    });
    return { target, literals };
  }

  private async writeEmbeddings(
    client: PoolClient,
    records: MemoryRecord[],
    prepared: { target: VectorTarget; literals: Map<string, string> },
  ): Promise<void> {
    const { target, literals } = prepared;
    for (let offset = 0; offset < records.length; offset += 500) {
      const chunk = records.slice(offset, offset + 500);
      const params = new Params();
      const rows = chunk.map((record) => {
        const literal = literals.get(record.id);
        if (literal === undefined) throw new Error(`postgres-provider: missing embedding for ${record.id}`);
        return `(${params.add(record.id)}, ${params.add(record.tenantId)}, ${params.add(record.appId)}, ` +
          `${params.add(this.embeddingModel)}, ${params.add(target.dims)}, ` +
          `${params.add(literal)}::vector(${target.dims}))`;
      });

      // Never reassign tenant_id/app_id: that would repoint another tenant's
      // vector row at this caller's content. The WHERE guard makes a
      // cross-scope collision a no-op, which the row count below turns into an
      // error rather than a silently stale vector.
      const result = await client.query(
        `INSERT INTO ${target.table} (memory_id, tenant_id, app_id, model, dims, embedding)
         VALUES ${rows.join(", ")}
         ON CONFLICT (memory_id) DO UPDATE SET
           model = EXCLUDED.model,
           dims = EXCLUDED.dims,
           embedding = EXCLUDED.embedding,
           updated_at = now()
         WHERE ${target.table}.tenant_id = EXCLUDED.tenant_id
           AND ${target.table}.app_id = EXCLUDED.app_id
         RETURNING memory_id`,
        params.values,
      );

      if ((result.rowCount ?? 0) !== chunk.length) {
        throw new Error(
          "postgres-provider: refusing to overwrite an embedding row owned by a different tenant/app scope",
        );
      }
    }
  }

  // -- writes ---------------------------------------------------------------

  async ingest(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    if (records.length === 0) return [];
    await this.ready();

    for (const record of records) {
      assertScope(record.tenantId, record.appId, "ingest");
      if (!record.id) throw new Error("postgres-provider: ingest requires a record id");
    }

    const prepared = await this.prepareEmbeddings(records);
    const ordered = orderForLocking(records);

    return this.withTransaction(async (client) => {
      const byId = new Map<string, MemoryRecord>();
      // 20 binds per row; 500 rows stays well inside the 65535 bind limit.
      for (let offset = 0; offset < ordered.length; offset += 500) {
        for (const row of await this.upsertChunk(client, ordered.slice(offset, offset + 500))) {
          byId.set(row.id, row);
        }
      }
      if (prepared) {
        const stored = ordered.map((record) => byId.get(record.id)).filter((row): row is MemoryRecord => Boolean(row));
        await this.writeEmbeddings(client, stored, prepared);
      }
      // RETURNING order is not guaranteed, so re-emit in the caller's order.
      return records.map((record) => byId.get(record.id)).filter((row): row is MemoryRecord => Boolean(row));
    });
  }

  private async upsertChunk(client: PoolClient, records: MemoryRecord[]): Promise<MemoryRecord[]> {
    const params = new Params();
    const rows = records.map((record) => {
      const cells = [
        params.add(record.id),
        params.add(record.tenantId),
        params.add(record.appId),
        params.add(record.actorId),
        params.add(record.threadId ?? null),
        params.add(record.scope),
        params.add(record.memoryType),
        params.add(record.text),
        params.add(record.summary ?? null),
        `${params.add(JSON.stringify(record.metadata ?? {}))}::jsonb`,
        `${params.add(record.confidence)}::real`,
        `${params.add(record.importance)}::real`,
        params.add(record.status),
        `${params.add(JSON.stringify(record.source ?? {}))}::jsonb`,
        `${params.add(JSON.stringify(record.decayPolicy ?? { kind: "none" }))}::jsonb`,
        `${params.add(record.firstSeenAt)}::timestamptz`,
        `${params.add(record.lastSeenAt)}::timestamptz`,
        `${params.add(record.createdAt)}::timestamptz`,
        `${params.add(record.updatedAt)}::timestamptz`,
        `${params.add(JSON.stringify(record.stats ?? {}))}::jsonb`,
      ];
      return `(${cells.join(", ")})`;
    });

    // Re-ingesting a known id refreshes mutable fields but never moves the
    // creation timestamps forward. tenant_id/app_id are deliberately absent from
    // the SET list and guarded in the WHERE: `id` is a global primary key, so
    // reassigning them would hand another tenant's row to this caller.
    const result = await client.query<MemoryRow>(
      `INSERT INTO memories (${columnList()})
       VALUES ${rows.join(", ")}
       ON CONFLICT (id) DO UPDATE SET
         actor_id = EXCLUDED.actor_id,
         thread_id = EXCLUDED.thread_id,
         scope = EXCLUDED.scope,
         memory_type = EXCLUDED.memory_type,
         text = EXCLUDED.text,
         summary = EXCLUDED.summary,
         metadata = EXCLUDED.metadata,
         confidence = EXCLUDED.confidence,
         importance = EXCLUDED.importance,
         status = EXCLUDED.status,
         source = EXCLUDED.source,
         decay_policy = EXCLUDED.decay_policy,
         first_seen_at = LEAST(memories.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_at = EXCLUDED.last_seen_at,
         created_at = LEAST(memories.created_at, EXCLUDED.created_at),
         updated_at = EXCLUDED.updated_at,
         stats = ${mergeStatsSql()}
       WHERE memories.tenant_id = EXCLUDED.tenant_id
         AND memories.app_id = EXCLUDED.app_id
       RETURNING ${columnList()}`,
      params.values,
    );

    // A blocked collision updates nothing and returns nothing. Raising beats
    // dropping the write silently: the caller learns the id is taken instead of
    // believing a store succeeded, and the transaction rolls the batch back.
    if (result.rows.length !== records.length) {
      const returned = new Set(result.rows.map((row) => row.id));
      const blocked = records.filter((record) => !returned.has(record.id)).map((record) => record.id);
      throw new Error(
        `postgres-provider: ingest refused ${blocked.length} record(s) whose id already exists under a ` +
          `different tenant/app scope: ${blocked.slice(0, 5).join(", ")}${blocked.length > 5 ? ", ..." : ""}`,
      );
    }
    return result.rows.map(mapRow);
  }

  async update(record: MemoryRecord): Promise<MemoryRecord> {
    const [saved] = await this.ingest([record]);
    if (!saved) throw new Error(`postgres-provider: update failed for record ${record.id}`);
    return saved;
  }

  /**
   * Scoped whenever the caller supplies tenantId/appId. Both are optional
   * because MemoryFeedbackInput is a public library type, so a legacy in-process
   * caller can still increment by bare id and read the row back; the HTTP
   * feedback route requires both so the externally reachable surface is scoped.
   * Construct with `requireIdScope: true` to reject unscoped calls outright.
   */
  async applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null> {
    await this.ready();
    const key = FEEDBACK_KEYS[feedback.signal];
    if (!key) throw new Error(`postgres-provider: unknown feedback signal "${feedback.signal}"`);
    if (this.requireIdScope) assertScope(feedback.tenantId, feedback.appId, "applyFeedback");

    const params: unknown[] = [feedback.memoryId, key];
    let scopeSql = "";
    if (feedback.tenantId) {
      params.push(feedback.tenantId);
      scopeSql += ` AND m.tenant_id = $${params.length}`;
    }
    if (feedback.appId) {
      params.push(feedback.appId);
      scopeSql += ` AND m.app_id = $${params.length}`;
    }

    // A single statement, so the row lock makes the increment atomic; no
    // read-modify-write window for concurrent writers to lose an update in.
    const result = await this.pool.query<MemoryRow>(
      `UPDATE memories m
          SET stats = jsonb_set(
                CASE WHEN jsonb_typeof(m.stats) = 'object' THEN m.stats ELSE '{}'::jsonb END,
                ARRAY[$2::text],
                to_jsonb(
                  (CASE WHEN jsonb_typeof(m.stats -> $2::text) = 'number'
                        THEN floor((m.stats ->> $2::text)::numeric)::bigint
                        ELSE 0::bigint END) + 1),
                true),
              last_seen_at = now(),
              updated_at = now()
        WHERE m.id = $1 AND m.status = 'active'${scopeSql}
        RETURNING ${columnList()}`,
      params,
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  // -- reads ----------------------------------------------------------------

  /** Compiles MemoryFilters to SQL. The returned fragment can be reused across
   *  several CTEs because bind placeholders are positional. */
  private buildFilter(
    alias: string,
    filters: MemoryFilters,
    params: Params,
    where: string,
  ): { sql: string; tenantRef: string; appRef: string } {
    assertScope(filters?.tenantId, filters?.appId, where);
    const tenantRef = params.add(filters.tenantId);
    const appRef = params.add(filters.appId);

    const parts = [`${alias}.tenant_id = ${tenantRef}`, `${alias}.app_id = ${appRef}`, `${alias}.status = 'active'`];

    if (filters.actorId) parts.push(`${alias}.actor_id = ${params.add(filters.actorId)}`);
    if (filters.threadId) parts.push(`${alias}.thread_id = ${params.add(filters.threadId)}`);
    if (filters.memoryTypes && filters.memoryTypes.length > 0) {
      parts.push(`${alias}.memory_type = ANY(${params.add(filters.memoryTypes)}::text[])`);
    }
    if (filters.scope && filters.scope.length > 0) {
      parts.push(`${alias}.scope = ANY(${params.add(filters.scope)}::text[])`);
    }
    if (filters.metadata && Object.keys(filters.metadata).length > 0) {
      parts.push(`${alias}.metadata @> ${params.add(JSON.stringify(filters.metadata))}::jsonb`);
    }
    if (this.hideExpiredOnRead) parts.push(`NOT ${expiredSql(alias)}`);

    return { sql: parts.join("\n           AND "), tenantRef, appRef };
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    await this.ready();
    const limit = Math.min(Math.max(query.limit ?? 8, 1), 100);
    const minScore = query.minScore ?? 0.2;
    const text = (query.query || "").trim();

    if (text.length === 0) return this.recentHits(query.filters, limit, minScore);

    const target = await this.vectorTarget();
    let queryVector: string | null = null;
    if (target) {
      const [vector] = await this.embedTexts([text]);
      queryVector = toVectorLiteral(vector, target.dims);
    }

    const params = new Params();
    const queryRef = params.add(text);
    const filter = this.buildFilter("m", query.filters, params, "search");
    const candidateRef = params.add(Math.min(limit * this.candidateMultiplier, MAX_CANDIDATES));
    const lexWeightRef = params.add(this.lexicalWeight);
    const vecWeightRef = params.add(this.vectorWeight);
    const rrfKRef = params.add(this.rrfK);

    let vectorCte = "vec_raw AS (SELECT NULL::text AS id, 0::float8 AS raw WHERE false)";
    if (target && queryVector !== null) {
      const vectorRef = params.add(queryVector);
      const distance = target.distance("e.embedding", vectorRef);
      vectorCte = `vec_raw AS (
          SELECT e.memory_id AS id, (1 - (${distance}))::float8 AS raw
            FROM ${target.table} e
            JOIN memories m ON m.id = e.memory_id
           WHERE e.tenant_id = ${filter.tenantRef}
             AND e.app_id = ${filter.appRef}
             AND ${filter.sql}
           ORDER BY ${distance}
           LIMIT ${candidateRef}
        )`;
    }

    const minScoreRef = params.add(minScore);
    const limitRef = params.add(limit);

    // Hybrid retrieval in one round trip: two independently ranked CTEs fused by
    // Reciprocal Rank Fusion, then blended with the record's own priors. Each
    // ranker filters `memories` directly so the planner can pick the GIN index
    // for the lexical side and HNSW for the vector side.
    const sql = `
      WITH q AS (
        SELECT plainto_tsquery('english', ${queryRef}) AS tsq_all,
               NULLIF(replace(plainto_tsquery('english', ${queryRef})::text, ' & ', ' | '), '')::tsquery AS tsq_any
      ),
      lex_raw AS (
        SELECT m.id,
               (ts_rank_cd(m.search_vector, q.tsq_any, 32)
                 * CASE WHEN m.search_vector @@ q.tsq_all THEN 1.0::float8 ELSE 0.85::float8 END)::float8 AS raw,
               m.last_seen_at
          FROM memories m CROSS JOIN q
         WHERE q.tsq_any IS NOT NULL
           AND m.search_vector @@ q.tsq_any
           AND ${filter.sql}
         ORDER BY 2 DESC, m.last_seen_at DESC
         LIMIT ${candidateRef}
      ),
      lex AS (
        SELECT id, raw, row_number() OVER (ORDER BY raw DESC, last_seen_at DESC) AS rnk FROM lex_raw
      ),
      ${vectorCte},
      vec AS (
        SELECT id, raw, row_number() OVER (ORDER BY raw DESC) AS rnk FROM vec_raw
      ),
      norm AS (
        SELECT GREATEST(
                 (CASE WHEN EXISTS (SELECT 1 FROM lex) THEN ${lexWeightRef}::numeric / (${rrfKRef}::numeric + 1) ELSE 0 END)
               + (CASE WHEN EXISTS (SELECT 1 FROM vec) THEN ${vecWeightRef}::numeric / (${rrfKRef}::numeric + 1) ELSE 0 END),
                 0.000000001) AS rrf_max
      ),
      fused AS (
        SELECT u.id,
               l.raw AS lex_raw, l.rnk AS lex_rnk,
               v.raw AS vec_raw, v.rnk AS vec_rnk,
               ((CASE WHEN l.rnk IS NULL THEN 0 ELSE ${lexWeightRef}::numeric / (${rrfKRef}::numeric + l.rnk) END)
              + (CASE WHEN v.rnk IS NULL THEN 0 ELSE ${vecWeightRef}::numeric / (${rrfKRef}::numeric + v.rnk) END)) AS rrf
          FROM (SELECT id FROM lex UNION SELECT id FROM vec) u
          LEFT JOIN lex l ON l.id = u.id
          LEFT JOIN vec v ON v.id = u.id
      ),
      components AS (
        SELECT ${columnList("m")},
               f.lex_raw::float8 AS lex_raw, f.lex_rnk, f.vec_raw::float8 AS vec_raw, f.vec_rnk,
               f.rrf::float8 AS rrf,
               LEAST(1::float8, (f.rrf / n.rrf_max)::float8) AS relevance,
               ${recencySql("m")} AS recency,
               ${feedbackSql("m")} AS feedback
          FROM fused f
          JOIN memories m ON m.id = f.id
          CROSS JOIN norm n
      ),
      scored AS (
        SELECT c.*,
               LEAST(1::float8, GREATEST(0::float8,
                 c.relevance * 0.55 + c.recency * 0.15 + c.confidence::float8 * 0.15
                 + c.importance::float8 * 0.10 + c.feedback)) AS score
          FROM components c
      )
      SELECT * FROM scored
       WHERE score >= ${minScoreRef}::float8
       ORDER BY score DESC, last_seen_at DESC
       LIMIT ${limitRef}`;

    const result = await this.pool.query<ScoredRow>(sql, params.values);
    return result.rows.map((row) => ({
      memory: mapRow(row),
      score: toNumber(row.score),
      reasons: explainHybrid(row),
    }));
  }

  /** Filter-only retrieval for a blank query: newest active rows first. */
  private async recentHits(filters: MemoryFilters, limit: number, minScore: number): Promise<MemorySearchHit[]> {
    const params = new Params();
    const filter = this.buildFilter("m", filters, params, "search");
    const minScoreRef = params.add(minScore);
    const limitRef = params.add(limit);

    const sql = `
      WITH components AS (
        SELECT ${columnList("m")},
               ${recencySql("m")} AS recency,
               ${feedbackSql("m")} AS feedback
          FROM memories m
         WHERE ${filter.sql}
         ORDER BY m.last_seen_at DESC
         LIMIT ${MAX_CANDIDATES}
      ),
      scored AS (
        SELECT c.*,
               LEAST(1::float8, GREATEST(0::float8,
                 c.recency * 0.4 + c.confidence::float8 * 0.3 + c.importance::float8 * 0.3 + c.feedback)) AS score
          FROM components c
      )
      SELECT * FROM scored
       WHERE score >= ${minScoreRef}::float8
       ORDER BY score DESC, last_seen_at DESC
       LIMIT ${limitRef}`;

    const result = await this.pool.query<ScoredRow>(sql, params.values);
    return result.rows.map((row) => ({
      memory: mapRow(row),
      score: toNumber(row.score),
      reasons: ["no query terms; ranked by recency and priors", ...explainPriors(row)],
    }));
  }

  async findDuplicate(candidate: MemoryRecord): Promise<MemoryRecord | null> {
    await this.ready();
    assertScope(candidate.tenantId, candidate.appId, "findDuplicate");

    // Index probe on memories_dedup_idx: the normalized-text hash is a stored
    // generated column, so this never degrades to a lower(text) scan.
    const result = await this.pool.query<MemoryRow>(
      `SELECT ${columnList("m")}
         FROM memories m
        WHERE m.tenant_id = $1
          AND m.app_id = $2
          AND m.actor_id = $3
          AND m.memory_type = $4
          AND m.status = 'active'
          AND m.text_hash = md5(lower(regexp_replace(btrim($5::text), '\\s+', ' ', 'g')))
          ${this.hideExpiredOnRead ? `AND NOT ${expiredSql("m")}` : ""}
        ORDER BY m.last_seen_at DESC
        LIMIT 1`,
      [candidate.tenantId, candidate.appId, candidate.actorId, candidate.memoryType, candidate.text],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]> {
    await this.ready();
    assertScope(tenantId, appId, "listByActor");
    if (!actorId) throw new Error("postgres-provider: listByActor requires an actorId");

    const result = await this.pool.query<MemoryRow>(
      `SELECT ${columnList("m")}
         FROM memories m
        WHERE m.tenant_id = $1
          AND m.app_id = $2
          AND m.actor_id = $3
          AND m.status = 'active'
          ${this.hideExpiredOnRead ? `AND NOT ${expiredSql("m")}` : ""}
        ORDER BY m.last_seen_at DESC
        LIMIT $4`,
      [tenantId, appId, actorId, this.maxListRows],
    );
    return result.rows.map(mapRow);
  }

  /**
   * The MemoryProvider interface carries no tenant on getById, so pass `scope`
   * whenever the caller knows it. An unscoped lookup by opaque id is the one
   * read path this provider cannot tenant-check on the caller's behalf;
   * `requireIdScope: true` refuses it instead of answering.
   */
  async getById(id: string, scope?: { tenantId: string; appId: string }): Promise<MemoryRecord | null> {
    await this.ready();
    if (this.requireIdScope) assertScope(scope?.tenantId, scope?.appId, "getById");
    if (!id) return null;

    const params: unknown[] = [id];
    let scopeSql = "";
    if (scope) {
      assertScope(scope.tenantId, scope.appId, "getById");
      params.push(scope.tenantId, scope.appId);
      scopeSql = "AND m.tenant_id = $2 AND m.app_id = $3";
    }

    const result = await this.pool.query<MemoryRow>(
      `SELECT ${columnList("m")}
         FROM memories m
        WHERE m.id = $1
          AND m.status = 'active'
          ${scopeSql}
          ${this.hideExpiredOnRead ? `AND NOT ${expiredSql("m")}` : ""}
        LIMIT 1`,
      params,
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  // -- maintenance ----------------------------------------------------------

  async compact(): Promise<MemoryCompactResult> {
    await this.ready();

    // One set-based statement archives every due row and reports real counts.
    const result = await this.pool.query<{ archived_expired: string; archived_superseded: string }>(
      `WITH due AS (
         SELECT m.id FROM memories m WHERE m.status = 'active' AND ${expiredSql("m")}
       ),
       expired AS (
         UPDATE memories SET status = 'archived', updated_at = now()
          WHERE id IN (SELECT id FROM due)
          RETURNING 1
       ),
       superseded AS (
         UPDATE memories SET status = 'archived', updated_at = now()
          WHERE status = 'superseded'
          RETURNING 1
       )
       SELECT (SELECT count(*) FROM expired) AS archived_expired,
              (SELECT count(*) FROM superseded) AS archived_superseded`,
    );

    return {
      archivedExpired: toNumber(result.rows[0]?.archived_expired),
      archivedSuperseded: toNumber(result.rows[0]?.archived_superseded),
    };
  }

  async health(): Promise<ProviderHealthStatus> {
    try {
      const result = await this.pool.query<{
        server_version: string;
        vector_version: string | null;
        total_rows: string;
        active_rows: string;
      }>(
        `SELECT current_setting('server_version') AS server_version,
                (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version,
                (SELECT count(*) FROM memories) AS total_rows,
                (SELECT count(*) FROM memories WHERE status = 'active') AS active_rows`,
      );
      const row = result.rows[0];
      const needsVector = Boolean(this.embedder);
      const hasVector = Boolean(row?.vector_version);
      const details = [
        `pg=${row?.server_version}`,
        `pgvector=${row?.vector_version ?? "absent"}`,
        `rows=${toNumber(row?.total_rows)}`,
        `active=${toNumber(row?.active_rows)}`,
        `embedder=${needsVector ? `${this.embeddingModel}/${this.embedder?.dims}d` : "none"}`,
      ];
      if (needsVector && !hasVector) details.push("vector search unavailable: run CREATE EXTENSION vector");
      return { ok: needsVector ? hasVector : true, provider: "postgres", detail: details.join(" ") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = isMissingRelation(error) ? " (apply migrations/001_init.sql)" : "";
      return { ok: false, provider: "postgres", detail: `${message}${hint}` };
    }
  }
}

function explainPriors(row: ScoredRow): string[] {
  const reasons: string[] = [];
  if (toNumber(row.recency) > 0.7) reasons.push("recent memory");
  if (toNumber(row.confidence) >= 0.75) reasons.push("high confidence");
  if (toNumber(row.importance) >= 0.75) reasons.push("high importance");
  const feedback = toNumber(row.feedback);
  if (feedback > 0.05) reasons.push("strong positive feedback");
  if (feedback < -0.05) reasons.push("negative feedback penalty");
  return reasons;
}

function explainHybrid(row: ScoredRow): string[] {
  const reasons: string[] = [];
  const lexRank = row.lex_rnk === null || row.lex_rnk === undefined ? null : toNumber(row.lex_rnk);
  const vecRank = row.vec_rnk === null || row.vec_rnk === undefined ? null : toNumber(row.vec_rnk);

  if (lexRank !== null) {
    reasons.push(`lexical rank ${lexRank} (ts_rank_cd ${toNumber(row.lex_raw).toFixed(4)})`);
  }
  if (vecRank !== null) {
    reasons.push(`vector rank ${vecRank} (cosine similarity ${toNumber(row.vec_raw).toFixed(4)})`);
  }
  if (lexRank !== null && vecRank !== null) {
    reasons.push(`both rankers agreed (rrf ${toNumber(row.rrf).toFixed(5)})`);
  } else if (vecRank !== null) {
    reasons.push("vector-only match: semantically close without shared wording");
  } else if (lexRank !== null) {
    reasons.push("lexical-only match: shared wording without vector support");
  }

  return [...reasons, ...explainPriors(row)];
}
