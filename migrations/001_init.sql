-- memory-core: Postgres + pgvector storage schema.
-- Idempotent and safe to re-run. Targets PostgreSQL 14+ and pgvector 0.5+.
--
--   psql -d memory_core_dev -f migrations/001_init.sql
--
-- pgvector is optional at migrate time: the full-text path installs and works
-- without it, and vector tables are created on demand once it is present.

BEGIN;

CREATE TABLE IF NOT EXISTS memory_core_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $mc$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'memory-core: pgvector unavailable (%). Full-text search still works; vector search stays disabled until CREATE EXTENSION vector succeeds.', SQLERRM;
END
$mc$;

-- Checked text instead of enum types: adding a memory type is an ALTER of the
-- constraint rather than type surgery, and it round-trips to TS unions directly.
CREATE TABLE IF NOT EXISTS memories (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  app_id        text NOT NULL,
  actor_id      text NOT NULL,
  thread_id     text,
  scope         text NOT NULL DEFAULT 'actor'
                  CHECK (scope IN ('thread', 'actor', 'workspace', 'app', 'tenant')),
  memory_type   text NOT NULL
                  CHECK (memory_type IN ('fact', 'preference', 'goal', 'project', 'episode',
                                         'tool_outcome', 'instruction', 'profile', 'pattern', 'summary')),
  text          text NOT NULL,
  summary       text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence    real NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  importance    real NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'superseded', 'archived')),
  source        jsonb NOT NULL DEFAULT '{}'::jsonb,
  decay_policy  jsonb NOT NULL DEFAULT '{"kind":"none"}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  stats         jsonb NOT NULL DEFAULT '{"selectedCount":0,"positiveCount":0,"negativeCount":0}'::jsonb,

  -- Dedup key: whitespace-collapsed lowercased text, hashed so the index key
  -- stays a fixed 32 bytes regardless of body length.
  text_hash text GENERATED ALWAYS AS
    (md5(lower(regexp_replace(btrim(text), '\s+', ' ', 'g')))) STORED,

  -- Lexical ranking source. Summary is weighted above body text so a curated
  -- one-liner outranks an incidental mention deep in the body.
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(text, '')), 'B')
  ) STORED
);

-- Every read is tenant-scoped, so composite keys lead with (tenant_id, app_id).
-- Most of these are partial on status='active' because virtually all reads do.
CREATE INDEX IF NOT EXISTS memories_tenant_app_active_idx
  ON memories (tenant_id, app_id, last_seen_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS memories_actor_idx
  ON memories (tenant_id, app_id, actor_id, last_seen_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS memories_thread_idx
  ON memories (tenant_id, app_id, thread_id, last_seen_at DESC)
  WHERE status = 'active' AND thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS memories_type_idx
  ON memories (tenant_id, app_id, memory_type, last_seen_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS memories_scope_idx
  ON memories (tenant_id, app_id, scope, last_seen_at DESC)
  WHERE status = 'active';

-- Non-active reads: supersede sweeps and compaction audits.
CREATE INDEX IF NOT EXISTS memories_status_idx
  ON memories (tenant_id, app_id, status, last_seen_at DESC);

-- Index-backed exact dedup, replacing the O(N) lower(text) scan. Not unique:
-- the same text may legitimately exist under a different scope or thread.
CREATE INDEX IF NOT EXISTS memories_dedup_idx
  ON memories (tenant_id, app_id, actor_id, memory_type, text_hash)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS memories_fts_idx
  ON memories USING gin (search_vector)
  WHERE status = 'active';

-- jsonb_path_ops is ~half the size of jsonb_ops and covers the @> containment
-- form that MemoryFilters.metadata compiles to.
CREATE INDEX IF NOT EXISTS memories_metadata_idx
  ON memories USING gin (metadata jsonb_path_ops)
  WHERE status = 'active';

-- compact() sweep: narrows to active rows whose decay kind can actually expire.
CREATE INDEX IF NOT EXISTS memories_decay_idx
  ON memories ((decay_policy ->> 'kind'), last_seen_at, created_at)
  WHERE status = 'active';

-- Embeddings live in one narrow table per dimension.
--
-- pgvector requires a fixed dimension per HNSW index, but the embedding model is
-- pluggable (bge-small 384, Voyage 1024, OpenAI 3072). One table per dimension
-- keeps a true fixed-dim vector(N) column with a real HNSW index, lets several
-- models coexist (distinguished by `model`), keeps `memories` free of wide
-- nullable columns, and lets a re-embedding run be a table swap.
--
-- HNSW on `vector` tops out at 2000 dims, so above that we index the halfvec
-- cast instead -- see memory_core_embedding_ops_note() for the query form.
CREATE OR REPLACE FUNCTION memory_core_ensure_embedding_dim(p_dims int)
RETURNS text
LANGUAGE plpgsql
AS $mc$
DECLARE
  tbl text;
BEGIN
  IF p_dims IS NULL OR p_dims < 1 OR p_dims > 16000 THEN
    RAISE EXCEPTION 'memory-core: embedding dimension % is out of range (1..16000)', p_dims;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'memory-core: pgvector is not installed in database %. Run: CREATE EXTENSION vector;', current_database();
  END IF;

  tbl := format('memory_embeddings_%s', p_dims);

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS %I (
      memory_id  text PRIMARY KEY REFERENCES memories (id) ON DELETE CASCADE,
      tenant_id  text NOT NULL,
      app_id     text NOT NULL,
      model      text NOT NULL,
      dims       int NOT NULL CHECK (dims = %L),
      embedding  vector(%s) NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )$f$, tbl, p_dims, p_dims);

  -- Lets the planner pre-filter by tenant before or after the ANN scan.
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, app_id)',
                 tbl || '_scope_idx', tbl);

  IF p_dims <= 2000 THEN
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding vector_cosine_ops)',
                   tbl || '_hnsw_idx', tbl);
  ELSE
    BEGIN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw ((embedding::halfvec(%s)) halfvec_cosine_ops)',
                     tbl || '_hnsw_idx', tbl, p_dims);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'memory-core: could not build a halfvec HNSW index for % dims (%). Vector search stays exact but unindexed.', p_dims, SQLERRM;
    END;
  END IF;

  RETURN tbl;
END
$mc$;

-- Query-side companion to the index choice above: 'vector' means order by
-- `embedding <=> $q::vector(N)`, 'halfvec' means order by the halfvec cast.
CREATE OR REPLACE FUNCTION memory_core_embedding_ops_note(p_dims int)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $mc$
  SELECT CASE WHEN p_dims <= 2000 THEN 'vector' ELSE 'halfvec' END
$mc$;

-- Bootstrap the default model's dimension (bge-small-en-v1.5) so a bare
-- `psql -f` yields a working install.
DO $mc$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    PERFORM memory_core_ensure_embedding_dim(384);
  ELSE
    RAISE NOTICE 'memory-core: skipped creating memory_embeddings_384 (pgvector absent).';
  END IF;
END
$mc$;

INSERT INTO memory_core_migrations (version)
VALUES ('001_init')
ON CONFLICT (version) DO NOTHING;

COMMIT;
