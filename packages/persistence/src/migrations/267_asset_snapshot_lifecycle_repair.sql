-- Repair databases that recorded 256/257 as applied before the lifecycle
-- snapshot binding was fully installed. This is forward-only and idempotent:
-- history remains immutable while the live schema converges on migration 257.
ALTER TABLE merchant_asset_lifecycle
  ADD COLUMN IF NOT EXISTS snapshot_entity_type TEXT NOT NULL DEFAULT 'asset';

DO $repair_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'merchant_asset_lifecycle'::regclass
      AND conname = 'merchant_asset_lifecycle_snapshot_entity_type_check'
  ) THEN
    ALTER TABLE merchant_asset_lifecycle
      ADD CONSTRAINT merchant_asset_lifecycle_snapshot_entity_type_check
      CHECK (snapshot_entity_type = 'asset');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'merchant_asset_lifecycle'::regclass
      AND conname = 'merchant_asset_lifecycle_asset_snapshot_fk'
  ) THEN
    ALTER TABLE merchant_asset_lifecycle
      ADD CONSTRAINT merchant_asset_lifecycle_asset_snapshot_fk
      FOREIGN KEY (workspace_id, snapshot_entity_type, asset_id)
      REFERENCES business_entity_snapshots (workspace_id, entity_type, entity_id)
      ON DELETE RESTRICT;
  END IF;
END
$repair_constraints$;

CREATE INDEX IF NOT EXISTS merchant_asset_lifecycle_snapshot_fk_idx
  ON merchant_asset_lifecycle (workspace_id, snapshot_entity_type, asset_id);

-- Migration 166 published executable point-pack versions without the
-- purchase-window policy required by the V3 order transaction. Append a new
-- immutable version instead of mutating deployed catalog facts.
WITH source AS (
  SELECT v.*, v.payload || jsonb_build_object(
    'purchasePolicy', jsonb_build_object(
      'approved', true,
      'version', 'commercial.points.purchase-window.v3',
      'expiresInSeconds', 604800
    )
  ) AS repaired_payload
  FROM commercial_catalog_sku_versions v
  WHERE v.id IN ('sku-version-points-500-v2', 'sku-version-points-2000-v2')
)
INSERT INTO commercial_catalog_sku_versions
  (id, sku_id, version, lifecycle, executable, price_fen, currency, price_mode,
   duration_days, payload, checksum, effective_at)
SELECT replace(id, '-v2', '-v3'), sku_id, 3, 'approved', true, price_fen,
       currency, price_mode, duration_days, repaired_payload,
       encode(sha256(convert_to(repaired_payload::text, 'UTF8')), 'hex'), now()
FROM source;

INSERT INTO commercial_catalog_sku_benefits
  (id, sku_version_id, benefit_code, quantity, raw_value, raw_unit,
   normalized_value, policy_ref, metadata)
SELECT replace(b.id, '-v2', '-v3'), replace(b.sku_version_id, '-v2', '-v3'),
       b.benefit_code, b.quantity, b.raw_value, b.raw_unit,
       b.normalized_value, b.policy_ref, b.metadata
FROM commercial_catalog_sku_benefits b
WHERE b.id IN ('benefit-pack-500-v2', 'benefit-pack-2000-v2');

INSERT INTO commercial_catalog_events_v2
  (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision)
SELECT 'catalog-event-' || replace(id, '-v2', '-v3'), 'sku_version',
       replace(id, '-v2', '-v3'), 'published', 'migration:267',
       'Repaired executable point-pack purchase-window policy',
       jsonb_build_object('source_version', id, 'repair', 'purchase_policy_v3'), 1
FROM commercial_catalog_sku_versions
WHERE id IN ('sku-version-points-500-v3', 'sku-version-points-2000-v3');

UPDATE commercial_catalog_sales_v3
SET current_version_id = replace(current_version_id, '-v2', '-v3'),
    state = 'on_sale', revision = revision + 1, updated_at = now()
WHERE current_version_id IN ('sku-version-points-500-v2', 'sku-version-points-2000-v2');

-- Migration 263 restored a broad workspace_members UPDATE grant for the
-- activation flow. Keep only the identity-binding columns required by Ops;
-- operator display names remain tenant-owned data.
REVOKE UPDATE ON workspace_members FROM merchant_ops;
GRANT UPDATE (identity_id, revision, updated_at) ON workspace_members TO merchant_ops;
