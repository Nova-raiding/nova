-- 232_storage_quota_unnameable_reservation_keys: give the legacy ledger rows
-- migration 231 could not name the object identity their durable records do
-- carry.
--
-- The hole this closes. A quota reservation is keyed
-- `asset:<assetId>/<canonical file name>` - one row per physical object (see
-- `reservationKeyFor` in packages/storage/src/reservation-key.ts, the only
-- implementation of that shape on either side of the ledger). Rows written by
-- the older one-row-per-asset scheme carry `asset:<assetId>` and are invisible
-- to both runtime paths: `reserve` looks up the per-object key, finds nothing
-- and inserts a second settled row, so one physical object is charged twice;
-- and `releaseAfterPhysicalDeletion` looks up the per-object key, finds nothing
-- and returns without lowering `used_bytes`, so the bytes stay charged after
-- the object is gone. Migration 231 renames such a row when the object name is
-- recoverable from the asset projection (`business_entity_snapshots`) or from
-- the scan receipts, and - deliberately - leaves the rest alone.
--
-- What 232 adds is the rest of the durable object references, so the set of
-- rows 231 had to skip shrinks to those whose asset has no durable record of
-- any object at all. For each remaining legacy row this migration collects every
-- object key the workspace's durable state names for that asset:
--
--   * the asset projection (231's first source),
--   * the append-only scan receipts (231's second source; kept because a row can
--     still be here when the projection was the source that failed),
--   * snapshots that embed the asset in an output list - a generation job keeps
--     `outputs[].assetId` and `outputs[].storageKey` for the candidates it
--     archived, and that survives the loss of the asset projection. The names
--     are the camel-case ones the snapshot payload actually carries: the
--     snapshot stores the `ImageGenerationJob`/`VisualGenerationOutput` object
--     verbatim (`assetId`, `storageKey`), so a snake-case read here matches no
--     row and silently contributes nothing,
--   * the outbox: an upload event carries `asset_id` and `storage_key`, and
--     published events are retained rather than deleted. These are snake-case
--     because the event payload is built field by field, unlike the snapshot,
--   * `object_storage_orphans`, which records the object keys whose deletion is
--     still outstanding - those objects exist on disk, and their key names the
--     asset. Only rows whose object still exists are read: `state = 'cleaned'`
--     is only ever set after the object was deleted (`markCleaned` in
--     object-orphan-repository.ts runs after `deleteObject` succeeds), and
--     naming a row after an object that is already gone would bind it to a key
--     no future deletion can repay - while leaving it unnamed keeps the
--     asset-scoped release fallback able to reclaim it.
--
-- The row is renamed only when every one of those sources agrees on a *single*
-- object file name for the asset, the key shape is exactly the four segments
-- `<zone>/<workspace>/<assetId>/<file>` the storage layer writes, and no
-- reservation already holds the target key. Anything else is left untouched for
-- the runtime's asset-scoped release fallback (see
-- `legacyReservationKeyCandidate` in storage-quota-repository.ts): guessing
-- which object an unnamed row paid for is exactly how a release came to credit
-- a sibling object that was still stored, and a wrong credit is worse than a
-- row that has to wait for its object to be deleted.
--
-- No row is released here. 231 releases only a duplicate it can prove (the
-- asset's whole receipt history names one file name); this migration always
-- takes the safe direction and only makes rows reachable by the exact-key
-- release path.
--
-- FORCE ROW LEVEL SECURITY. Every table read here carries FORCE (migrations
-- 001/002, 004, 084, 043), which applies the policy to the table owner too, and
-- the deployed migration credential is the schema owner rather than a
-- superuser: without the `NO FORCE` below the backfill would read zero rows in
-- every workspace and silently do nothing. The suspension and its restoration
-- live in the migration's single transaction, so an aborted run rolls the flag
-- back with everything else.
--
-- Locks. `NO FORCE` takes ACCESS EXCLUSIVE on each table, so live traffic
-- against them waits for this migration. The loop visits only rows that still
-- carry a legacy key, which is bounded by the assets uploaded before the key
-- changed and that 231 could not name.
--
-- Idempotent. The selection matches only rows that still carry the legacy key
-- and every row this migration acts on stops matching it, so a second run is a
-- no-op.

ALTER TABLE storage_quota_reservations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_storage_quotas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE business_entity_snapshots NO FORCE ROW LEVEL SECURITY;
ALTER TABLE asset_scan_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE object_storage_orphans NO FORCE ROW LEVEL SECURITY;

DO $storage_quota_unnameable_reservation_keys$
DECLARE
  legacy RECORD;
  file_name text;
  file_name_count integer;
  target_key text;
BEGIN
  FOR legacy IN
    SELECT r.workspace_id, r.asset_id, r.reservation_key
      FROM storage_quota_reservations r
     WHERE r.status <> 'released'
       AND r.reservation_key = 'asset:' || r.asset_id
     ORDER BY r.workspace_id, r.asset_id
       FOR UPDATE
  LOOP
    file_name := NULL;
    file_name_count := 0;

    -- Distinct *file names*: quarantine and clean keys for one promoted object
    -- are the same object under two zones, and the ledger key is the same for
    -- both.
    SELECT count(DISTINCT split_part(candidate.object_key, '/', 4)), min(split_part(candidate.object_key, '/', 4))
      INTO file_name_count, file_name
      FROM (
        SELECT NULLIF(btrim(s.payload->>'storageKey'), '') AS object_key
          FROM business_entity_snapshots s
         WHERE s.workspace_id = legacy.workspace_id
           AND s.entity_type = 'asset'
           AND s.entity_id = legacy.asset_id
        UNION ALL
        SELECT NULLIF(btrim(output.object->>'storageKey'), '')
          FROM business_entity_snapshots s
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(s.payload->'outputs') = 'array' THEN s.payload->'outputs' ELSE '[]'::jsonb END
          ) AS output(object)
         WHERE s.workspace_id = legacy.workspace_id
           AND output.object->>'assetId' = legacy.asset_id
        UNION ALL
        SELECT NULLIF(btrim(receipt.object_key), '')
          FROM asset_scan_receipts receipt
         WHERE receipt.workspace_id = legacy.workspace_id
           AND receipt.asset_id = legacy.asset_id
        UNION ALL
        SELECT NULLIF(btrim(event.payload->>'storage_key'), '')
          FROM outbox_events event
         WHERE event.workspace_id = legacy.workspace_id
           AND event.payload->>'asset_id' = legacy.asset_id
        UNION ALL
        SELECT NULLIF(btrim(orphan.object_key), '')
          FROM object_storage_orphans orphan
         WHERE orphan.workspace_id = legacy.workspace_id
           AND orphan.state <> 'cleaned'
      ) candidate
     WHERE candidate.object_key IS NOT NULL
       AND split_part(candidate.object_key, '/', 1) IN ('quarantine', 'clean')
       AND split_part(candidate.object_key, '/', 2) = legacy.workspace_id
       AND split_part(candidate.object_key, '/', 3) = legacy.asset_id
       AND split_part(candidate.object_key, '/', 4) <> ''
       AND split_part(candidate.object_key, '/', 5) = '';

    -- One object, or none. Two names mean the asset really has (or had) two
    -- objects and this row cannot be attributed to either of them.
    IF file_name_count <> 1 THEN
      CONTINUE;
    END IF;

    target_key := 'asset:' || legacy.asset_id || '/' || file_name;

    -- A row already holds the target key: the asset was re-uploaded after the
    -- key change, so the two rows may describe one object (charged twice) or
    -- two. That is not decidable here; leave the legacy row for the runtime's
    -- asset-scoped release fallback.
    IF EXISTS (
      SELECT 1 FROM storage_quota_reservations occupied
       WHERE occupied.workspace_id = legacy.workspace_id
         AND occupied.reservation_key = target_key
    ) THEN
      CONTINUE;
    END IF;

    UPDATE storage_quota_reservations
       SET reservation_key = target_key, revision = revision + 1, updated_at = now()
     WHERE workspace_id = legacy.workspace_id
       AND reservation_key = legacy.reservation_key;
  END LOOP;
END
$storage_quota_unnameable_reservation_keys$;

ALTER TABLE storage_quota_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_storage_quotas FORCE ROW LEVEL SECURITY;
ALTER TABLE business_entity_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE asset_scan_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE object_storage_orphans FORCE ROW LEVEL SECURITY;
