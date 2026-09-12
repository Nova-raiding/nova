-- 187_enterprise_tenant_root: make the enterprise boundary explicit without
-- changing the current workspace-level RLS boundary.
--
-- Existing deployments use one workspace per merchant enterprise. Backfill
-- one enterprise row per existing workspace so the relationship is explicit
-- and deterministic. Future deployments may attach multiple workspaces to
-- one enterprise without using enterprise_name or identity_id as a security
-- key.

CREATE TABLE IF NOT EXISTS enterprises (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS enterprise_id text;

INSERT INTO enterprises (id, name, status, created_at)
SELECT id, 'Enterprise ' || id, status, created_at
FROM workspaces
ON CONFLICT (id) DO NOTHING;

UPDATE workspaces
SET enterprise_id = id
WHERE enterprise_id IS NULL;

ALTER TABLE workspaces
  ALTER COLUMN enterprise_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'workspaces'::regclass
      AND conname = 'workspaces_enterprise_id_fkey'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_enterprise_id_fkey
      FOREIGN KEY (enterprise_id) REFERENCES enterprises(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS workspaces_enterprise_id_idx
  ON workspaces (enterprise_id, id);

ALTER TABLE enterprises ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprises FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS enterprises_platform_scope ON enterprises;
CREATE POLICY enterprises_platform_scope ON enterprises
  USING (current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_setting('app.platform_scope', true) = 'platform_ops');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON enterprises FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON enterprises TO merchant_ops;
  END IF;
END
$$;
