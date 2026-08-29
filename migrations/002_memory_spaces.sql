-- memory-core: stable cross-agent space boundary and scoped vector ownership.
-- Applies after 001_init.sql. Idempotent for safe recovery, but the provider's
-- migration ledger executes it only once during normal deploys.

BEGIN;

CREATE TABLE IF NOT EXISTS memory_core_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Privacy-preserving legacy backfill: old records enter the owning actor's
-- personal space. Operators can explicitly move intended team-shared records
-- after reviewing them; migration must never broaden visibility implicitly.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS space_id text;
UPDATE memories SET space_id = actor_id WHERE space_id IS NULL OR btrim(space_id) = '';
ALTER TABLE memories ALTER COLUMN space_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS memories_space_active_idx
  ON memories (tenant_id, space_id, scope, last_seen_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS memories_dedup_v2_idx
  ON memories (tenant_id, scope, memory_type, text_hash, space_id, actor_id, thread_id, app_id)
  WHERE status = 'active';

-- Upgrade every embedding table that already exists before replacing the
-- provisioning function used for future dimensions.
DO $mc$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = current_schema()
       AND tablename ~ '^memory_embeddings_[0-9]+$'
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS space_id text', table_name);
    EXECUTE format(
      'UPDATE %I e SET space_id = m.space_id FROM memories m WHERE e.memory_id = m.id AND e.space_id IS NULL',
      table_name
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN space_id SET NOT NULL', table_name);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, space_id)',
      table_name || '_space_idx',
      table_name
    );
  END LOOP;
END
$mc$;

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
      space_id   text NOT NULL,
      app_id     text NOT NULL,
      model      text NOT NULL,
      dims       int NOT NULL CHECK (dims = %L),
      embedding  vector(%s) NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )$f$, tbl, p_dims, p_dims);

  -- Idempotent upgrade in case a dimension was provisioned by an older binary
  -- between the schema migration and application rollout.
  EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS space_id text', tbl);
  EXECUTE format(
    'UPDATE %I e SET space_id = m.space_id FROM memories m WHERE e.memory_id = m.id AND e.space_id IS NULL',
    tbl
  );
  EXECUTE format('ALTER TABLE %I ALTER COLUMN space_id SET NOT NULL', tbl);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, app_id)', tbl || '_scope_idx', tbl);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, space_id)', tbl || '_space_idx', tbl);

  IF p_dims <= 2000 THEN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding vector_cosine_ops)',
      tbl || '_hnsw_idx',
      tbl
    );
  ELSE
    BEGIN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw ((embedding::halfvec(%s)) halfvec_cosine_ops)',
        tbl || '_hnsw_idx',
        tbl,
        p_dims
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'memory-core: could not build a halfvec HNSW index for % dims (%). Vector search stays exact but unindexed.', p_dims, SQLERRM;
    END;
  END IF;

  RETURN tbl;
END
$mc$;

INSERT INTO memory_core_migrations (version)
VALUES ('002_memory_spaces')
ON CONFLICT (version) DO NOTHING;

COMMIT;
