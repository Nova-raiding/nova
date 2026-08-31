-- Global, operator-governed evidence registry for platform media specifications.
CREATE OR REPLACE FUNCTION platform_media_spec_json_depth(payload JSONB)
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE jsonb_typeof(payload)
    WHEN 'object' THEN 1 + COALESCE((SELECT max(platform_media_spec_json_depth(value)) FROM jsonb_each(payload)), 0)
    WHEN 'array' THEN 1 + COALESCE((SELECT max(platform_media_spec_json_depth(value)) FROM jsonb_array_elements(payload)), 0)
    ELSE 1
  END
$$;

CREATE OR REPLACE FUNCTION platform_media_spec_scope_safe(value TEXT, maximum_length INTEGER)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT value <> ''
    AND value = normalize(btrim(value), NFKC)
    AND char_length(value) <= maximum_length
    AND NOT EXISTS (
      SELECT 1
      FROM generate_series(1, char_length(value)) AS position
      CROSS JOIN LATERAL (SELECT ascii(substr(value, position, 1)) AS codepoint) AS character
      WHERE codepoint BETWEEN 0 AND 31 OR codepoint BETWEEN 127 AND 159
        OR codepoint IN (173, 1564, 1757, 1807, 6158, 65279)
        OR codepoint BETWEEN 1536 AND 1541 OR codepoint BETWEEN 2274 AND 2274
        OR codepoint BETWEEN 8203 AND 8207 OR codepoint BETWEEN 8234 AND 8238
        OR codepoint BETWEEN 8288 AND 8292 OR codepoint BETWEEN 8294 AND 8303
        OR codepoint BETWEEN 65529 AND 65531 OR codepoint BETWEEN 69821 AND 69821
        OR codepoint BETWEEN 69837 AND 69837 OR codepoint BETWEEN 78896 AND 78911
        OR codepoint BETWEEN 113824 AND 113827 OR codepoint BETWEEN 119155 AND 119162
        OR codepoint BETWEEN 917505 AND 917505 OR codepoint BETWEEN 917536 AND 917631
    )
$$;

CREATE TABLE IF NOT EXISTS platform_media_specs (
  id UUID PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('taobao', 'tmall', 'jd', 'pinduoduo', 'xiaohongshu', 'douyin')),
  placement TEXT NOT NULL,
  placement_nfkc TEXT GENERATED ALWAYS AS (normalize(btrim(placement), NFKC)) STORED,
  device TEXT NOT NULL CHECK (device IN ('desktop', 'mobile')),
  version TEXT NOT NULL,
  version_nfkc TEXT GENERATED ALWAYS AS (normalize(btrim(version), NFKC)) STORED,
  spec_json JSONB NOT NULL CHECK (
    jsonb_typeof(spec_json) = 'object'
    AND spec_json <> '{}'::jsonb
    AND octet_length(spec_json::text) <= 65536
    AND platform_media_spec_json_depth(spec_json) <= 12
  ),
  source_url TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  checked_at TIMESTAMPTZ NOT NULL,
  evidence_artifact_ref TEXT,
  evidence_artifact_sha256 TEXT CHECK (evidence_artifact_sha256 IS NULL OR evidence_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  immutable_digest TEXT NOT NULL CHECK (immutable_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'expired')),
  expires_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, placement_nfkc, device, version_nfkc),
  CHECK (platform_media_spec_scope_safe(placement, 200)),
  CHECK (platform_media_spec_scope_safe(version, 100)),
  CHECK (platform_media_spec_scope_safe(source_url, 2000) AND source_url ~ '^https://[^/[:space:]]+' AND source_url !~ '^https://[^/]*@'),
  CHECK (checked_at <= updated_at),
  CHECK (
    status = 'draft'
    OR (
      evidence_artifact_ref IS NOT NULL AND btrim(evidence_artifact_ref) <> ''
      AND evidence_artifact_sha256 IS NOT NULL
      AND expires_at IS NOT NULL
      AND approved_by IS NOT NULL AND btrim(approved_by) <> ''
      AND approved_at IS NOT NULL
    )
  )
);

-- PostgreSQL cannot use now() in a partial unique-index predicate. Approved
-- rows are transitioned to expired by the repository before a successor is
-- approved, making this stricter index race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS platform_media_specs_one_approved_scope_idx
  ON platform_media_specs (platform, placement_nfkc, device)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS platform_media_specs_active_lookup_idx
  ON platform_media_specs (platform, placement_nfkc, device, expires_at DESC)
  WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS platform_media_spec_audit (
  id UUID PRIMARY KEY,
  spec_id UUID NOT NULL REFERENCES platform_media_specs(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'approved', 'expired', 'auto_expired')),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('merchant_ops', 'system')),
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  before_json JSONB,
  after_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (btrim(actor_id) <> '' AND btrim(reason) <> '' AND btrim(idempotency_key) <> '')
);

CREATE INDEX IF NOT EXISTS platform_media_spec_audit_timeline_idx
  ON platform_media_spec_audit (spec_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_platform_media_spec_immutable_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('approved', 'expired') AND (
    NEW.platform IS DISTINCT FROM OLD.platform OR
    NEW.placement IS DISTINCT FROM OLD.placement OR
    NEW.device IS DISTINCT FROM OLD.device OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.spec_json IS DISTINCT FROM OLD.spec_json OR
    NEW.source_url IS DISTINCT FROM OLD.source_url OR
    NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256 OR
    NEW.checked_at IS DISTINCT FROM OLD.checked_at OR
    NEW.evidence_artifact_ref IS DISTINCT FROM OLD.evidence_artifact_ref OR
    NEW.evidence_artifact_sha256 IS DISTINCT FROM OLD.evidence_artifact_sha256 OR
    NEW.immutable_digest IS DISTINCT FROM OLD.immutable_digest OR
    NEW.expires_at IS DISTINCT FROM OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'approved platform media specification evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'expired' AND NEW.status IS DISTINCT FROM 'expired' THEN
    RAISE EXCEPTION 'expired platform media specification cannot be reactivated' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS platform_media_specs_immutable_evidence ON platform_media_specs;
CREATE TRIGGER platform_media_specs_immutable_evidence
  BEFORE UPDATE ON platform_media_specs
  FOR EACH ROW EXECUTE FUNCTION protect_platform_media_spec_immutable_evidence();

CREATE OR REPLACE VIEW active_platform_media_specs
WITH (security_barrier = true)
AS
SELECT id, platform, placement, device, version, spec_json,
       immutable_digest, checked_at, expires_at, revision
FROM platform_media_specs
WHERE status = 'approved' AND expires_at > now();

REVOKE ALL ON TABLE platform_media_specs, platform_media_spec_audit, active_platform_media_specs FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_media_spec_json_depth(JSONB), platform_media_spec_scope_safe(TEXT, INTEGER), protect_platform_media_spec_immutable_evidence() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE platform_media_specs, platform_media_spec_audit, active_platform_media_specs FROM merchant_app;
    GRANT SELECT ON TABLE active_platform_media_specs TO merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON TABLE platform_media_specs, platform_media_spec_audit, active_platform_media_specs FROM merchant_ops;
    GRANT SELECT, INSERT, UPDATE ON TABLE platform_media_specs TO merchant_ops;
    GRANT SELECT, INSERT ON TABLE platform_media_spec_audit TO merchant_ops;
    GRANT EXECUTE ON FUNCTION platform_media_spec_json_depth(JSONB), platform_media_spec_scope_safe(TEXT, INTEGER) TO merchant_ops;
  END IF;
END
$$;
