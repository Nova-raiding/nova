-- 086_trusted_clean_asset_backfill: fail closed for legacy asset snapshots
-- whose clean state is not backed by the immutable signed-receipt ledger.
--
-- This migration changes metadata only. It never deletes or moves an object,
-- receipt, snapshot, or business relation. Ambiguous JSON is intentionally
-- treated as untrusted and downgraded to blocked.
CREATE OR REPLACE FUNCTION asset_snapshot_is_trusted_clean(
  p_workspace_id text,
  p_asset_id text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $trusted_clean_asset$
DECLARE
  source_revision integer;
  storage_key text;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(p_payload->'id') <> 'string'
     OR p_payload->>'id' <> p_asset_id
     OR jsonb_typeof(p_payload->'workspaceId') <> 'string'
     OR p_payload->>'workspaceId' <> p_workspace_id
     OR p_workspace_id = ''
     OR p_workspace_id ~ '[/\\]'
     OR jsonb_typeof(p_payload->'sourceRevision') <> 'number'
     OR p_payload->>'sourceRevision' !~ '^[1-9][0-9]*$'
     OR jsonb_typeof(p_payload->'scanReceiptId') <> 'string'
     OR p_payload->>'scanReceiptId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR jsonb_typeof(p_payload->'scanReceiptDigest') <> 'string'
     OR p_payload->>'scanReceiptDigest' !~ '^[a-f0-9]{64}$'
     OR p_payload->>'scanVerdict' <> 'clean'
     OR jsonb_typeof(p_payload->'storageKey') <> 'string' THEN
    RETURN false;
  END IF;

  IF (p_payload->>'sourceRevision')::numeric > 2147483647 THEN
    RETURN false;
  END IF;

  source_revision := (p_payload->>'sourceRevision')::integer;
  storage_key := p_payload->>'storageKey';
  IF left(storage_key, length('clean/' || p_workspace_id || '/')) <> 'clean/' || p_workspace_id || '/'
     OR length(storage_key) <= length('clean/' || p_workspace_id || '/')
     OR position(E'\\' IN storage_key) <> 0
     OR EXISTS (
       SELECT 1
       FROM unnest(string_to_array(storage_key, '/')) AS segment(value)
       WHERE segment.value IN ('', '.', '..')
     ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM asset_scan_receipts receipt
    WHERE receipt.workspace_id = p_workspace_id
      AND receipt.asset_id = p_asset_id
      AND receipt.asset_source_revision = source_revision
      AND receipt.receipt_id = p_payload->>'scanReceiptId'
      AND receipt.receipt_digest = p_payload->>'scanReceiptDigest'
      AND receipt.verdict = 'clean'
  );
END;
$trusted_clean_asset$;

WITH untrusted_clean_assets AS (
  SELECT snapshot.workspace_id, snapshot.entity_id
  FROM business_entity_snapshots snapshot
  WHERE snapshot.entity_type = 'asset'
    AND snapshot.payload->>'scanStatus' = 'clean'
    AND NOT asset_snapshot_is_trusted_clean(snapshot.workspace_id, snapshot.entity_id, snapshot.payload)
)
UPDATE business_entity_snapshots snapshot
SET payload = jsonb_set(
      jsonb_set(snapshot.payload, '{scanStatus}', '"blocked"'::jsonb, true),
      '{revision}',
      to_jsonb(snapshot.entity_version + 1),
      true
    ),
    entity_version = snapshot.entity_version + 1,
    updated_at = now()
FROM untrusted_clean_assets candidate
WHERE snapshot.workspace_id = candidate.workspace_id
  AND snapshot.entity_type = 'asset'
  AND snapshot.entity_id = candidate.entity_id;

CREATE OR REPLACE FUNCTION enforce_asset_snapshot_trusted_clean()
RETURNS trigger
LANGUAGE plpgsql
AS $enforce_trusted_clean_asset$
BEGIN
  IF NEW.entity_type = 'asset'
     AND NEW.payload->>'scanStatus' = 'clean'
     AND NOT asset_snapshot_is_trusted_clean(NEW.workspace_id, NEW.entity_id, NEW.payload) THEN
    RAISE EXCEPTION 'asset clean state requires a trusted signed scan receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$enforce_trusted_clean_asset$;

DROP TRIGGER IF EXISTS business_entity_asset_trusted_clean ON business_entity_snapshots;
CREATE TRIGGER business_entity_asset_trusted_clean
BEFORE INSERT OR UPDATE OF workspace_id,entity_type,entity_id,payload ON business_entity_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_asset_snapshot_trusted_clean();
