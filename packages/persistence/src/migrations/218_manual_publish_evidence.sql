-- 218_manual_publish_evidence: tenant-scoped evidence for the manual six-platform
-- workflow. These rows are human reports, never official platform API receipts.

ALTER TABLE business_entity_snapshots
  DROP CONSTRAINT IF EXISTS business_entity_snapshots_entity_type_supported_check;
ALTER TABLE business_entity_snapshots
  ADD CONSTRAINT business_entity_snapshots_entity_type_supported_check
  CHECK (entity_type IN ('product','task','content_version','publish_job','manual_publish_record','publish_batch','platform_account','generation_job','image_generation_job','brand_profile','asset','feedback','sync_job','automation_policy','merchant_intent'));

CREATE UNIQUE INDEX IF NOT EXISTS tasks_workspace_product_id_key
  ON tasks (workspace_id, product_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS content_versions_workspace_task_id_key
  ON content_versions (workspace_id, task_id, id);

CREATE TABLE manual_publish_evidence (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')),
  platform_account_id TEXT NOT NULL CHECK (
    length(btrim(platform_account_id)) BETWEEN 1 AND 255
    AND platform_account_id !~ '[[:cntrl:]]'
  ),
  product_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  approved_content_version_id TEXT NOT NULL,
  delivery_bundle_sha256 TEXT NOT NULL CHECK (delivery_bundle_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_manifest_sha256 TEXT NOT NULL CHECK (evidence_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN (
    'export_ready',
    'manual_publish_in_progress',
    'manual_publish_reported',
    'manual_review_required'
  )),
  publisher_actor_id TEXT,
  reviewer_actor_id TEXT,
  reported_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  remote_content_id TEXT,
  public_url TEXT,
  platform_display_status TEXT,
  evidence_asset_refs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_asset_refs) = 'array'),
  difference_notes TEXT NOT NULL DEFAULT '',
  exception_notes TEXT NOT NULL DEFAULT '',
  created_by_actor_id TEXT NOT NULL CHECK (length(btrim(created_by_actor_id)) BETWEEN 1 AND 255),
  updated_by_actor_id TEXT NOT NULL CHECK (length(btrim(updated_by_actor_id)) BETWEEN 1 AND 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT manual_publish_evidence_account_scope_fk
    FOREIGN KEY (workspace_id, platform, platform_account_id)
    REFERENCES platform_accounts (workspace_id, platform, id) ON DELETE RESTRICT,
  CONSTRAINT manual_publish_evidence_task_product_scope_fk
    FOREIGN KEY (workspace_id, product_id, task_id)
    REFERENCES tasks (workspace_id, product_id, id) ON DELETE RESTRICT,
  CONSTRAINT manual_publish_evidence_content_task_scope_fk
    FOREIGN KEY (workspace_id, task_id, approved_content_version_id)
    REFERENCES content_versions (workspace_id, task_id, id) ON DELETE RESTRICT,
  CONSTRAINT manual_publish_evidence_reported_fields CHECK (
    status NOT IN ('manual_publish_reported', 'manual_review_required')
    OR (
      publisher_actor_id IS NOT NULL
      AND length(btrim(publisher_actor_id)) BETWEEN 1 AND 255
      AND reported_at IS NOT NULL
    )
  ),
  CONSTRAINT manual_publish_evidence_review_fields CHECK (
    reviewed_at IS NULL OR (
      reviewer_actor_id IS NOT NULL
      AND length(btrim(reviewer_actor_id)) BETWEEN 1 AND 255
    )
  ),
  CONSTRAINT manual_publish_evidence_url_shape CHECK (
    public_url IS NULL OR public_url ~ '^https://[^[:space:][:cntrl:]]+$'
  )
);

CREATE INDEX manual_publish_evidence_work_queue_idx
  ON manual_publish_evidence (workspace_id, status, updated_at DESC, id DESC);

CREATE INDEX manual_publish_evidence_product_idx
  ON manual_publish_evidence (workspace_id, product_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX manual_publish_evidence_bundle_identity_idx
  ON manual_publish_evidence (
    workspace_id, platform, platform_account_id, product_id,
    approved_content_version_id, delivery_bundle_sha256
  );

ALTER TABLE manual_publish_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_publish_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY manual_publish_evidence_workspace_isolation ON manual_publish_evidence
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DO $manual_publish_evidence_acl$
BEGIN
  REVOKE ALL ON manual_publish_evidence FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON manual_publish_evidence TO merchant_app;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON manual_publish_evidence FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT, UPDATE ON manual_publish_evidence TO merchant_ops;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON manual_publish_evidence FROM merchant_ops;
  END IF;
END
$manual_publish_evidence_acl$;
