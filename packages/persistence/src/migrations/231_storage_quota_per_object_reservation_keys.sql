-- 231_storage_quota_per_object_reservation_keys: rewrite the pre-per-object
-- storage quota ledger keys into the per-object form the runtime uses today.
--
-- The hole this closes. A storage quota reservation used to be keyed
-- `asset:<assetId>` - one row per asset - and both the reserving side and the
-- releasing side used that one key. It is now keyed
-- `asset:<assetId>/<canonical file name>`, one row per physical object (see
-- `assetReservationKeyForObject` in apps/api/src/server.ts). `reservation_key`
-- is half of `storage_quota_reservations`' primary key and nothing rewrote the
-- rows the older code left behind, so every reservation settled before the key
-- changed is unreachable from both runtime paths:
--
--   * `reserve` looks the row up by the per-object key, finds nothing and
--     inserts a second settled reservation. Re-uploading the same bytes under
--     the same file name deduplicates to the same physical object in the
--     object store (no new bytes are written) yet is charged again, so
--     `used_bytes` grows with no corresponding object.
--   * `releaseAfterPhysicalDeletion` looks the row up by the per-object key,
--     finds nothing and returns without touching the workspace totals, so
--     `used_bytes` never falls when the object the orphaned row paid for is
--     deleted - neither through the orphan cleanup nor through the write
--     compensation path.
--
-- A workspace then rejects uploads with STORAGE_QUOTA_EXCEEDED while holding
-- far less than its limit. Nothing self-heals: the repository exposes no
-- "list and repair one reservation" operation and
-- `/v1/internal/storage/reconciliation` is a read-only snapshot.
--
-- The rewrite target is the canonical file name of the object the asset
-- currently points at. That is exactly the suffix the runtime derives, from
-- the upload request (`canonicalStorageFileName`, which duplicates
-- `safeFileName` in packages/storage/src/object-storage.ts) and from the
-- stored object key (`assetReservationKeyForDeletedObject`). It is read back
-- from durable state instead of being recomputed here, so this file cannot
-- drift from either implementation:
--
--   * `business_entity_snapshots` (entity_type = 'asset') is the durable asset
--     projection and carries the live `storageKey`;
--   * `asset_scan_receipts` is the append-only scan evidence and carries the
--     `object_key` of the revision the asset was last scanned at.
--
-- Collisions. If the per-object key already exists, the asset was re-uploaded
-- after the key change and before this migration, so the same physical object
-- may be charged twice. That is repaired only when it is *provable*: the asset
-- must have exactly one distinct object file name across its scan receipts.
-- When the asset has had more than one file name, the two rows can describe
-- two objects that really are both on disk (a re-upload under a different name
-- writes a new object key and leaves the previous object behind), so the
-- legacy row is left alone rather than credited on a guess.
--
-- Rows that cannot be named at all - the snapshot is gone and no receipt
-- survives - are also left alone. The prefix fallback added to
-- `PostgresStorageQuotaRepository.releaseInternal` in the same change reclaims
-- them when their object is deleted, which is the direction that leaks bytes.
--
-- FORCE ROW LEVEL SECURITY. Both ledger tables, and the two tables the file
-- name is read from, carry `FORCE ROW LEVEL SECURITY` (migration 080,
-- migration 004). FORCE makes the policy apply to the table owner too, and the
-- deployed migration credential is the schema owner, not a superuser: without
-- the `NO FORCE` below the backfill would read zero rows in every workspace and
-- silently do nothing. `SET LOCAL row_security = off` (migration 163) is not an
-- option here for the same reason - for a role that cannot bypass RLS it
-- raises. The suspension and restoration below live in the migration's single
-- transaction, so an aborted run rolls the flag back with everything else, and
-- no other session can observe the widened owner visibility.
--
-- Locks. `NO FORCE` takes ACCESS EXCLUSIVE on all four tables, so live
-- reserve/settle/read traffic against them waits for this migration. The loop
-- visits only rows that still carry a legacy key, which is bounded by the
-- assets uploaded before the key change.
--
-- Idempotent. The selection matches only rows that still carry the legacy key,
-- and every row this migration acts on stops matching it: it is either renamed
-- or released, and released rows are excluded. A second run is a no-op.

ALTER TABLE storage_quota_reservations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_storage_quotas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE business_entity_snapshots NO FORCE ROW LEVEL SECURITY;
ALTER TABLE asset_scan_receipts NO FORCE ROW LEVEL SECURITY;

DO $storage_quota_per_object_reservation_keys$
DECLARE
  legacy RECORD;
  target RECORD;
  storage_key text;
  file_name text;
  target_key text;
  legacy_is_active boolean;
  legacy_actual_bytes bigint;
  receipt_names text[];
BEGIN
  FOR legacy IN
    SELECT r.workspace_id, r.asset_id, r.reservation_key, r.status, r.reserved_bytes, r.actual_bytes
      FROM storage_quota_reservations r
     WHERE r.status <> 'released'
       AND r.reservation_key = 'asset:' || r.asset_id
     ORDER BY r.workspace_id, r.asset_id
       FOR UPDATE
  LOOP
    storage_key := NULL;
    file_name := NULL;

    SELECT NULLIF(btrim(s.payload->>'storageKey'), '')
      INTO storage_key
      FROM business_entity_snapshots s
     WHERE s.workspace_id = legacy.workspace_id
       AND s.entity_type = 'asset'
       AND s.entity_id = legacy.asset_id;

    IF storage_key IS NULL THEN
      -- `asset_scan_receipts.object_key` is constrained to
      -- `quarantine/<workspace>/...`, so it names the same file the
      -- quarantine reservation was keyed by.
      SELECT NULLIF(btrim(r.object_key), '')
        INTO storage_key
        FROM asset_scan_receipts r
       WHERE r.workspace_id = legacy.workspace_id
         AND r.asset_id = legacy.asset_id
       ORDER BY r.asset_source_revision DESC
       LIMIT 1;
    END IF;

    IF storage_key IS NULL THEN
      CONTINUE;
    END IF;

    -- Only accept a key that belongs to this workspace and this asset, and that
    -- has exactly the four segments `<zone>/<workspace>/<asset>/<file>` the
    -- storage layer writes: the last segment is then the canonical file name
    -- both runtime paths hash into the reservation key. Anything else is left
    -- for the release fallback rather than guessed at.
    IF split_part(storage_key, '/', 1) NOT IN ('quarantine', 'clean')
       OR split_part(storage_key, '/', 2) <> legacy.workspace_id
       OR split_part(storage_key, '/', 3) <> legacy.asset_id
       OR split_part(storage_key, '/', 4) = ''
       OR split_part(storage_key, '/', 5) <> '' THEN
      CONTINUE;
    END IF;

    file_name := split_part(storage_key, '/', 4);
    target_key := 'asset:' || legacy.asset_id || '/' || file_name;

    SELECT t.reservation_key, t.status
      INTO target
      FROM storage_quota_reservations t
     WHERE t.workspace_id = legacy.workspace_id
       AND t.reservation_key = target_key
       FOR UPDATE;

    IF FOUND THEN
      -- Every distinct object file name this asset ever produced. A receipt is
      -- only ever appended, so an empty set proves nothing and is not enough
      -- to call the two rows the same object.
      SELECT array_agg(DISTINCT split_part(r.object_key, '/', 4))
        INTO receipt_names
        FROM asset_scan_receipts r
       WHERE r.workspace_id = legacy.workspace_id
         AND r.asset_id = legacy.asset_id;

      IF receipt_names IS NULL OR receipt_names <> ARRAY[file_name] THEN
        CONTINUE;
      END IF;

      -- Same physical object, charged twice: the per-object row is the one the
      -- runtime can still reach, so the legacy row is repaid and released.
      legacy_is_active := legacy.status = 'active';
      legacy_actual_bytes := COALESCE(legacy.actual_bytes, 0);

      UPDATE storage_quota_reservations
         SET reserved_bytes = 0, actual_bytes = NULL, status = 'released',
             revision = revision + 1, updated_at = now()
       WHERE workspace_id = legacy.workspace_id
         AND reservation_key = legacy.reservation_key;

      UPDATE workspace_storage_quotas
         SET reserved_bytes = reserved_bytes - (CASE WHEN legacy_is_active THEN legacy.reserved_bytes ELSE 0 END),
             used_bytes = used_bytes - (CASE WHEN legacy_is_active THEN 0 ELSE legacy_actual_bytes END),
             revision = revision + 1, updated_at = now()
       WHERE workspace_id = legacy.workspace_id;

      CONTINUE;
    END IF;

    UPDATE storage_quota_reservations
       SET reservation_key = target_key, revision = revision + 1, updated_at = now()
     WHERE workspace_id = legacy.workspace_id
       AND reservation_key = legacy.reservation_key;
  END LOOP;
END
$storage_quota_per_object_reservation_keys$;

ALTER TABLE storage_quota_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_storage_quotas FORCE ROW LEVEL SECURITY;
ALTER TABLE business_entity_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE asset_scan_receipts FORCE ROW LEVEL SECURITY;
