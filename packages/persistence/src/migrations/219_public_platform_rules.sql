-- 219_public_platform_rules: platform-operations managed rules shared by all merchants.
-- This table is deliberately not workspace-scoped. Merchant workspaces may
-- read active versions, while only the operations role can mutate lifecycle
-- state. Brand/store rules remain in rule_pack_versions and brand bindings.

CREATE TABLE IF NOT EXISTS public_platform_rule_versions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')),
  pack_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  version TEXT NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'inactive', 'expired')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('official', 'internal', 'legal_review')),
  source_reference TEXT NOT NULL CHECK (length(btrim(source_reference)) BETWEEN 1 AND 2048),
  source_checked_at TIMESTAMPTZ NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  checks JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checks) = 'object'),
  severity TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('warning', 'error')),
  action TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'warn', 'review', 'allow')),
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (platform, pack_id, version),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_from < effective_to)
);

CREATE INDEX IF NOT EXISTS public_platform_rule_active_idx
  ON public_platform_rule_versions (platform, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public_platform_rule_audits (
  id TEXT PRIMARY KEY,
  rule_version_id TEXT NOT NULL REFERENCES public_platform_rule_versions(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'activated', 'deactivated', 'expired')),
  actor_id TEXT NOT NULL CHECK (length(btrim(actor_id)) BETWEEN 1 AND 255),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2048),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object')
);

CREATE OR REPLACE FUNCTION reject_public_platform_rule_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $public_platform_rule_audit_append_only$
BEGIN
  RAISE EXCEPTION 'public platform rule audits are append-only' USING ERRCODE = '55000';
END;
$public_platform_rule_audit_append_only$;

DROP TRIGGER IF EXISTS public_platform_rule_audits_append_only ON public_platform_rule_audits;
CREATE TRIGGER public_platform_rule_audits_append_only
  BEFORE UPDATE OR DELETE ON public_platform_rule_audits
  FOR EACH ROW EXECUTE FUNCTION reject_public_platform_rule_audit_mutation();

REVOKE ALL ON public_platform_rule_versions, public_platform_rule_audits FROM PUBLIC;
DO $public_platform_rule_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT ON public_platform_rule_versions TO merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT, UPDATE ON public_platform_rule_versions TO merchant_ops;
    GRANT SELECT, INSERT ON public_platform_rule_audits TO merchant_ops;
  END IF;
END
$public_platform_rule_acl$;
