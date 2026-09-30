-- Bind asset lifecycle rows to the durable tenant-scoped asset snapshot.
-- Migration 256 supplies the lifecycle table and its guards; this forward-only
-- constraint makes the relationship enforceable by PostgreSQL itself.
ALTER TABLE merchant_asset_lifecycle
  ADD COLUMN snapshot_entity_type TEXT NOT NULL DEFAULT 'asset',
  ADD CONSTRAINT merchant_asset_lifecycle_snapshot_entity_type_check
    CHECK (snapshot_entity_type = 'asset'),
  ADD CONSTRAINT merchant_asset_lifecycle_asset_snapshot_fk
    FOREIGN KEY (workspace_id, snapshot_entity_type, asset_id)
    REFERENCES business_entity_snapshots (workspace_id, entity_type, entity_id)
    ON DELETE RESTRICT;

CREATE INDEX merchant_asset_lifecycle_snapshot_fk_idx
  ON merchant_asset_lifecycle (workspace_id, snapshot_entity_type, asset_id);
