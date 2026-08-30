-- memory-core: cross-replica exact-dedupe arbitration.
--
-- A service-side SELECT followed by INSERT cannot prevent two replicas from
-- creating the same logical memory. These five scope-specific unique indexes
-- encode memoryVisibilityKey() in PostgreSQL 14-compatible form. The migration
-- takes a short write lock so cleanup and index creation are one atomic schema
-- transition; reads continue while it runs.

BEGIN;

LOCK TABLE memories IN SHARE ROW EXCLUSIVE MODE;

-- MD5 remains for the older lookup index. The uniqueness boundary uses the
-- built-in SHA-256 function so adversarially chosen MD5 collisions cannot merge
-- two different memories. Keeping the normalized-text equality checks in the
-- provider adds a fail-closed collision guard as well. The SHA expression lives
-- directly in each index: PostgreSQL 14 would rewrite the whole heap for a new
-- STORED generated column, needlessly blocking reads during an upgrade.
--
-- convert_to(text, encoding) is catalogued STABLE because the database encoding
-- is implicit. A database's encoding cannot change after creation and the
-- target here is explicit, so this narrow wrapper is legitimately immutable and
-- can be used by an index expression.
CREATE OR REPLACE FUNCTION memory_core_text_sha256(value text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $mc$
  SELECT sha256(convert_to(value, 'UTF8'))
$mc$;

-- A cryptographic collision must stop the migration, never choose a winner.
DO $mc$
BEGIN
  IF EXISTS (
    WITH keyed AS (
      SELECT tenant_id,
             scope,
             memory_type,
             memory_core_text_sha256(
               lower(regexp_replace(btrim(text), '\s+', ' ', 'g'))
             ) AS dedupe_hash,
             CASE WHEN scope <> 'tenant' THEN space_id ELSE '' END AS locus_space,
             CASE WHEN scope = 'app' THEN app_id ELSE '' END AS locus_app,
             CASE WHEN scope IN ('actor', 'thread') THEN actor_id ELSE '' END AS locus_actor,
             CASE WHEN scope = 'thread' THEN coalesce(thread_id, '') ELSE '' END AS locus_thread,
             lower(regexp_replace(btrim(text), '\s+', ' ', 'g')) AS normalized_text
        FROM memories
       WHERE status = 'active'
    )
    SELECT 1
      FROM keyed
     GROUP BY tenant_id, scope, memory_type, dedupe_hash,
              locus_space, locus_app, locus_actor, locus_thread
    HAVING count(DISTINCT normalized_text) > 1
  ) THEN
    RAISE EXCEPTION 'memory-core: SHA-256 collision in active exact-dedupe keys; migration aborted';
  END IF;
END
$mc$;

-- Preserve every loser for audit, but select exactly one active survivor per
-- canonical visibility locus before adding the invariant. A non-expired row is
-- preferred, followed by newest observation/update and a stable id tie-break.
CREATE TEMP TABLE memory_core_dedupe_losers (
  loser_id  text PRIMARY KEY,
  winner_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO memory_core_dedupe_losers (loser_id, winner_id)
WITH active AS (
  SELECT id,
         tenant_id,
         scope,
         memory_type,
         memory_core_text_sha256(
           lower(regexp_replace(btrim(text), '\s+', ' ', 'g'))
         ) AS dedupe_hash,
         CASE WHEN scope <> 'tenant' THEN space_id ELSE '' END AS locus_space,
         CASE WHEN scope = 'app' THEN app_id ELSE '' END AS locus_app,
         CASE WHEN scope IN ('actor', 'thread') THEN actor_id ELSE '' END AS locus_actor,
         CASE WHEN scope = 'thread' THEN coalesce(thread_id, '') ELSE '' END AS locus_thread,
         last_seen_at,
         updated_at,
         (
           (decay_policy ->> 'kind') IN ('time', 'inactivity')
           AND CASE
                 WHEN (decay_policy ->> 'ttlDays') ~ '^[0-9]+(\.[0-9]+)?$'
                   THEN (decay_policy ->> 'ttlDays')::numeric
                 ELSE 180
               END > 0
           AND CASE
                 WHEN (decay_policy ->> 'kind') = 'inactivity' THEN last_seen_at
                 ELSE created_at
               END < now() - CASE
                 WHEN (decay_policy ->> 'ttlDays') ~ '^[0-9]+(\.[0-9]+)?$'
                   THEN (decay_policy ->> 'ttlDays')::numeric
                 ELSE 180
               END * interval '1 day'
         ) AS is_expired
    FROM memories
   WHERE status = 'active'
), ranked AS (
  SELECT id,
         first_value(id) OVER dedupe_group AS winner_id,
         row_number() OVER dedupe_group AS ordinal
    FROM active
  WINDOW dedupe_group AS (
    PARTITION BY tenant_id, scope, memory_type, dedupe_hash,
                 locus_space, locus_app, locus_actor, locus_thread
    ORDER BY is_expired ASC, last_seen_at DESC, updated_at DESC, id ASC
  )
)
SELECT id, winner_id
  FROM ranked
 WHERE ordinal > 1;

-- Merge monotonic evidence into each survivor. Metadata keys use the value from
-- the most recently updated member; feedback counters are summed so cleanup
-- does not discard signals collected against race-created ids.
WITH membership AS (
  SELECT winner_id, loser_id AS member_id FROM memory_core_dedupe_losers
  UNION ALL
  SELECT DISTINCT winner_id, winner_id FROM memory_core_dedupe_losers
), aggregates AS (
  SELECT members.winner_id,
         min(m.first_seen_at) AS first_seen_at,
         min(m.created_at) AS created_at,
         max(m.last_seen_at) AS last_seen_at,
         max(m.confidence) AS confidence,
         max(m.importance) AS importance,
         sum(CASE WHEN jsonb_typeof(m.stats -> 'selectedCount') = 'number'
                  THEN floor((m.stats ->> 'selectedCount')::numeric) ELSE 0 END) AS selected_count,
         sum(CASE WHEN jsonb_typeof(m.stats -> 'positiveCount') = 'number'
                  THEN floor((m.stats ->> 'positiveCount')::numeric) ELSE 0 END) AS positive_count,
         sum(CASE WHEN jsonb_typeof(m.stats -> 'negativeCount') = 'number'
                  THEN floor((m.stats ->> 'negativeCount')::numeric) ELSE 0 END) AS negative_count,
         sum(CASE WHEN jsonb_typeof(m.stats -> 'accessCount') = 'number'
                  THEN floor((m.stats ->> 'accessCount')::numeric) ELSE 0 END) AS access_count,
         bool_or(CASE WHEN jsonb_typeof(m.stats) = 'object'
                      THEN m.stats ? 'accessCount' ELSE false END) AS has_access_count
    FROM membership members
    JOIN memories m ON m.id = members.member_id
   GROUP BY members.winner_id
), metadata_entries AS (
  SELECT members.winner_id,
         entry.key,
         entry.value,
         row_number() OVER (
           PARTITION BY members.winner_id, entry.key
           ORDER BY m.updated_at DESC, m.id ASC
         ) AS precedence
    FROM membership members
    JOIN memories m ON m.id = members.member_id
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(m.metadata) = 'object' THEN m.metadata ELSE '{}'::jsonb END
    ) AS entry
), merged_metadata AS (
  SELECT winner_id,
         jsonb_object_agg(key, value) FILTER (WHERE precedence = 1) AS metadata
    FROM metadata_entries
   GROUP BY winner_id
)
UPDATE memories winner
   SET first_seen_at = aggregate.first_seen_at,
       created_at = aggregate.created_at,
       last_seen_at = aggregate.last_seen_at,
       updated_at = now(),
       confidence = aggregate.confidence,
       importance = aggregate.importance,
       metadata = coalesce(merged.metadata, winner.metadata),
       stats = (CASE WHEN jsonb_typeof(winner.stats) = 'object' THEN winner.stats ELSE '{}'::jsonb END)
               || jsonb_build_object(
                    'selectedCount', aggregate.selected_count,
                    'positiveCount', aggregate.positive_count,
                    'negativeCount', aggregate.negative_count
                  )
               || CASE WHEN aggregate.has_access_count
                       THEN jsonb_build_object('accessCount', aggregate.access_count)
                       ELSE '{}'::jsonb END
  FROM aggregates aggregate
  LEFT JOIN merged_metadata merged ON merged.winner_id = aggregate.winner_id
 WHERE winner.id = aggregate.winner_id;

UPDATE memories loser
   SET status = 'superseded',
       updated_at = now(),
       metadata = (CASE WHEN jsonb_typeof(loser.metadata) = 'object'
                        THEN loser.metadata ELSE '{}'::jsonb END)
                  || jsonb_build_object(
                       'supersededBy', mapping.winner_id,
                       'supersedeReason', 'migration-003-concurrent-dedupe',
                       'supersededAt', now()
                     )
  FROM memory_core_dedupe_losers mapping
 WHERE loser.id = mapping.loser_id;

CREATE UNIQUE INDEX memories_active_tenant_dedupe_uidx
  ON memories (
    tenant_id,
    memory_type,
    (memory_core_text_sha256(lower(regexp_replace(btrim(text), '\s+', ' ', 'g'))))
  )
  WHERE status = 'active' AND scope = 'tenant';

CREATE UNIQUE INDEX memories_active_workspace_dedupe_uidx
  ON memories (
    tenant_id,
    space_id,
    memory_type,
    (memory_core_text_sha256(lower(regexp_replace(btrim(text), '\s+', ' ', 'g'))))
  )
  WHERE status = 'active' AND scope = 'workspace';

CREATE UNIQUE INDEX memories_active_app_dedupe_uidx
  ON memories (
    tenant_id,
    space_id,
    app_id,
    memory_type,
    (memory_core_text_sha256(lower(regexp_replace(btrim(text), '\s+', ' ', 'g'))))
  )
  WHERE status = 'active' AND scope = 'app';

CREATE UNIQUE INDEX memories_active_actor_dedupe_uidx
  ON memories (
    tenant_id,
    space_id,
    actor_id,
    memory_type,
    (memory_core_text_sha256(lower(regexp_replace(btrim(text), '\s+', ' ', 'g'))))
  )
  WHERE status = 'active' AND scope = 'actor';

CREATE UNIQUE INDEX memories_active_thread_dedupe_uidx
  ON memories (
    tenant_id,
    space_id,
    actor_id,
    coalesce(thread_id, ''),
    memory_type,
    (memory_core_text_sha256(lower(regexp_replace(btrim(text), '\s+', ' ', 'g'))))
  )
  WHERE status = 'active' AND scope = 'thread';

INSERT INTO memory_core_migrations (version)
VALUES ('003_concurrent_dedupe')
ON CONFLICT (version) DO NOTHING;

COMMIT;
