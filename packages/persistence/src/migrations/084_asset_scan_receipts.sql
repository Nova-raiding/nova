CREATE TABLE IF NOT EXISTS asset_scan_receipts (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  asset_id TEXT NOT NULL,
  asset_source_revision INTEGER NOT NULL CHECK (asset_source_revision > 0),
  receipt_digest TEXT NOT NULL UNIQUE CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  signature TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('clean','malicious','suspicious','unsupported')),
  object_key TEXT NOT NULL,
  object_sha256 TEXT NOT NULL CHECK (object_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_payload TEXT NOT NULL,
  receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_scan_receipts_asset_revision_unique
    UNIQUE (workspace_id,asset_id,asset_source_revision),
  CONSTRAINT asset_scan_receipts_subject_matches_columns CHECK (
    jsonb_typeof(receipt) = 'object'
    AND canonical_payload::jsonb = receipt
    AND receipt->>'schema_version' IS NOT DISTINCT FROM 'asset-scan-receipt/1.0'
    AND receipt->>'receipt_id' IS NOT DISTINCT FROM receipt_id
    AND receipt->'subject'->>'workspace_id' IS NOT DISTINCT FROM workspace_id
    AND receipt->'subject'->>'asset_id' IS NOT DISTINCT FROM asset_id
    AND (receipt->'subject'->>'asset_source_revision')::INTEGER IS NOT DISTINCT FROM asset_source_revision
    AND receipt->'subject'->>'object_key' IS NOT DISTINCT FROM object_key
    AND receipt->'subject'->>'sha256' IS NOT DISTINCT FROM object_sha256
    AND receipt->'scan'->>'verdict' IS NOT DISTINCT FROM verdict
    AND object_key LIKE 'quarantine/' || workspace_id || '/%'
  )
);

CREATE INDEX IF NOT EXISTS asset_scan_receipts_workspace_created_idx
  ON asset_scan_receipts (workspace_id,created_at DESC,receipt_id DESC);

ALTER TABLE asset_scan_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_scan_receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asset_scan_receipts_workspace_isolation ON asset_scan_receipts;
CREATE POLICY asset_scan_receipts_workspace_isolation ON asset_scan_receipts
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_asset_scan_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $asset_scan_receipts_append_only$
BEGIN
  RAISE EXCEPTION 'asset scan receipts are append-only' USING ERRCODE = '55000';
END;
$asset_scan_receipts_append_only$;

DROP TRIGGER IF EXISTS asset_scan_receipts_append_only ON asset_scan_receipts;
CREATE TRIGGER asset_scan_receipts_append_only
BEFORE UPDATE OR DELETE ON asset_scan_receipts
FOR EACH ROW EXECUTE FUNCTION reject_asset_scan_receipt_mutation();

REVOKE ALL ON TABLE asset_scan_receipts FROM PUBLIC;
DO $asset_scan_receipts_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE asset_scan_receipts FROM merchant_app;
    GRANT SELECT, INSERT ON TABLE asset_scan_receipts TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE asset_scan_receipts FROM merchant_app;
  END IF;
END
$asset_scan_receipts_grants$;
