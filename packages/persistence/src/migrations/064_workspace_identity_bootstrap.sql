-- Bind one authenticated issuer/subject pair to its bootstrap workspace.
-- This is identity-scoped control data, not caller-selected tenant data.

CREATE TABLE IF NOT EXISTS workspace_identity_bindings (
  issuer TEXT NOT NULL CHECK (length(btrim(issuer)) BETWEEN 1 AND 512),
  external_subject TEXT NOT NULL CHECK (length(btrim(external_subject)) BETWEEN 1 AND 512),
  identity_id UUID REFERENCES platform_identities(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, external_subject)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_identity_bindings_identity_key
  ON workspace_identity_bindings (identity_id)
  WHERE identity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_identity_bindings_workspace_idx
  ON workspace_identity_bindings (workspace_id);

-- Preserve an existing active owner relationship when upgrading. If legacy
-- data contains duplicate owner workspaces, bind the identity to the oldest
-- active one instead of making the migration destructive.
INSERT INTO workspace_identity_bindings (
  issuer, external_subject, identity_id, workspace_id, display_name, created_at, updated_at
)
SELECT DISTINCT ON (identity.issuer, identity.external_subject)
  identity.issuer,
  identity.external_subject,
  identity.id,
  member.workspace_id,
  CASE WHEN length(btrim(member.display_name)) > 0 THEN left(member.display_name, 120) ELSE '商家工作区' END,
  member.created_at,
  member.updated_at
FROM platform_identities identity
JOIN workspace_members member ON member.identity_id = identity.id
JOIN workspaces workspace ON workspace.id = member.workspace_id
WHERE member.role = 'workspace_owner'
  AND member.status = 'active'
  AND workspace.status = 'active'
ORDER BY identity.issuer, identity.external_subject, workspace.created_at ASC, member.workspace_id ASC
ON CONFLICT DO NOTHING;

ALTER TABLE workspace_identity_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_identity_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_identity_bindings_identity_scope ON workspace_identity_bindings;
CREATE POLICY workspace_identity_bindings_identity_scope ON workspace_identity_bindings
  USING (
    issuer = current_setting('app.identity_issuer', true)
    AND external_subject = current_setting('app.identity_subject', true)
  )
  WITH CHECK (
    issuer = current_setting('app.identity_issuer', true)
    AND external_subject = current_setting('app.identity_subject', true)
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE workspace_identity_bindings TO merchant_app;
  END IF;
END
$$;
