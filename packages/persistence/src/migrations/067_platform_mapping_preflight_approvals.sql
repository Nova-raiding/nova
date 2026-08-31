-- Durable, tenant-scoped approval replacing process-local mapping preflight state.
CREATE TABLE IF NOT EXISTS platform_mapping_preflight_approvals (
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('taobao', 'tmall', 'jd', 'pinduoduo', 'xiaohongshu', 'douyin')),
  product_id TEXT NOT NULL,
  product_version INTEGER NOT NULL CHECK (product_version > 0),
  mapped_payload_sha256 TEXT NOT NULL CHECK (mapped_payload_sha256 ~ '^[0-9a-f]{64}$'),
  remote_snapshot_sha256 TEXT NOT NULL CHECK (remote_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  schema_version TEXT NOT NULL,
  schema_evidence_sha256 TEXT NOT NULL CHECK (schema_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_version TEXT NOT NULL,
  mapping_evidence_sha256 TEXT NOT NULL CHECK (mapping_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  publishable BOOLEAN NOT NULL,
  confirmation_valid BOOLEAN NOT NULL,
  externally_unverified BOOLEAN NOT NULL,
  finding_codes JSONB NOT NULL CHECK (jsonb_typeof(finding_codes) = 'array' AND jsonb_array_length(finding_codes) <= 256),
  evaluated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform, product_id),
  CONSTRAINT platform_mapping_preflight_product_scope_fk FOREIGN KEY (workspace_id, product_id)
    REFERENCES products (workspace_id, id) ON DELETE CASCADE,
  CHECK (btrim(workspace_id) <> '' AND length(workspace_id) <= 255 AND workspace_id !~ '[[:cntrl:]]'),
  CHECK (product_id = normalize(btrim(product_id), NFKC) AND product_id <> '' AND length(product_id) <= 255 AND product_id !~ '[[:cntrl:]]'),
  CHECK (schema_version = normalize(btrim(schema_version), NFKC) AND schema_version <> '' AND length(schema_version) <= 200 AND schema_version !~ '[[:cntrl:]]'),
  CHECK (mapping_version = normalize(btrim(mapping_version), NFKC) AND mapping_version <> '' AND length(mapping_version) <= 200 AND mapping_version !~ '[[:cntrl:]]'),
  CHECK (btrim(created_by) <> '' AND length(created_by) <= 255 AND created_by !~ '[[:cntrl:]]'),
  CHECK (expires_at > evaluated_at),
  CHECK (revoked_at IS NULL OR revoked_at >= evaluated_at),
  CHECK (evaluated_at <= updated_at)
);

CREATE INDEX IF NOT EXISTS platform_mapping_preflight_active_idx
  ON platform_mapping_preflight_approvals (workspace_id, platform, product_id, product_version, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE platform_mapping_preflight_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_mapping_preflight_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_mapping_preflight_workspace_scope ON platform_mapping_preflight_approvals;
CREATE POLICY platform_mapping_preflight_workspace_scope ON platform_mapping_preflight_approvals
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

REVOKE ALL ON TABLE platform_mapping_preflight_approvals FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE platform_mapping_preflight_approvals FROM merchant_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE platform_mapping_preflight_approvals TO merchant_app;
  END IF;
END
$$;
