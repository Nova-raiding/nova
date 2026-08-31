-- 105_durable_authorization_grants: durable platform roles and revocable JIT
-- customer-data grants. These are control-plane records. Only the dedicated
-- merchant_ops role, inside an explicit platform-scoped transaction, may read
-- or mutate them. Tenant/runtime connections receive no table privileges.

CREATE TABLE IF NOT EXISTS authorization_revisions (
  subject_identity_id UUID PRIMARY KEY REFERENCES platform_identities(id),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by TEXT NOT NULL CHECK (updated_by = btrim(updated_by) AND length(updated_by) BETWEEN 1 AND 255 AND updated_by !~ '[[:cntrl:]]'),
  update_reason TEXT NOT NULL CHECK (update_reason = btrim(update_reason) AND length(update_reason) BETWEEN 3 AND 1000 AND update_reason !~ '[[:cntrl:]]'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_role_assignments (
  id UUID PRIMARY KEY,
  subject_identity_id UUID NOT NULL REFERENCES platform_identities(id),
  role TEXT NOT NULL CHECK (role IN ('platform_owner','platform_admin','ops_admin','support_agent','finance_ops','security_admin','auditor','rules_admin','model_admin','release_admin')),
  assigned_by TEXT NOT NULL CHECK (assigned_by = btrim(assigned_by) AND length(assigned_by) BETWEEN 1 AND 255 AND assigned_by !~ '[[:cntrl:]]'),
  reason TEXT NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 1000 AND reason !~ '[[:cntrl:]]'),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  revocation_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  authorization_revision BIGINT NOT NULL CHECK (authorization_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > valid_from),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL)),
  CHECK (revoked_by IS NULL OR (revoked_by = btrim(revoked_by) AND length(revoked_by) BETWEEN 1 AND 255 AND revoked_by !~ '[[:cntrl:]]')),
  CHECK (revocation_reason IS NULL OR (revocation_reason = btrim(revocation_reason) AND length(revocation_reason) BETWEEN 3 AND 1000 AND revocation_reason !~ '[[:cntrl:]]'))
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_role_assignments_unrevoked_unique
  ON platform_role_assignments (subject_identity_id, role)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS platform_role_assignments_subject_active_idx
  ON platform_role_assignments (subject_identity_id, valid_from, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_role_assignment_events (
  id UUID PRIMARY KEY,
  assignment_id UUID NOT NULL REFERENCES platform_role_assignments(id),
  subject_identity_id UUID NOT NULL REFERENCES platform_identities(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('assigned','revoked')),
  actor_id TEXT NOT NULL CHECK (actor_id = btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255 AND actor_id !~ '[[:cntrl:]]'),
  reason TEXT NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 1000 AND reason !~ '[[:cntrl:]]'),
  authorization_revision BIGINT NOT NULL CHECK (authorization_revision > 0),
  assignment_revision INTEGER NOT NULL CHECK (assignment_revision > 0),
  snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops_access_grants (
  id UUID PRIMARY KEY,
  grant_kind TEXT NOT NULL CHECK (grant_kind IN ('temporary','support')),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read','write')),
  subject_identity_id UUID NOT NULL REFERENCES platform_identities(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  capabilities TEXT[] NOT NULL CHECK (cardinality(capabilities) BETWEEN 1 AND 100),
  resource_scope JSONB NOT NULL CHECK (jsonb_typeof(resource_scope) = 'object' AND resource_scope <> '{}'::jsonb),
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 1000 AND reason !~ '[[:cntrl:]]'),
  ticket_ref TEXT NOT NULL CHECK (ticket_ref = btrim(ticket_ref) AND length(ticket_ref) BETWEEN 1 AND 255 AND ticket_ref !~ '[[:cntrl:]]'),
  issued_by TEXT NOT NULL CHECK (issued_by = btrim(issued_by) AND length(issued_by) BETWEEN 1 AND 255 AND issued_by !~ '[[:cntrl:]]'),
  approved_by TEXT NOT NULL CHECK (approved_by = btrim(approved_by) AND length(approved_by) BETWEEN 1 AND 255 AND approved_by !~ '[[:cntrl:]]'),
  approved_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  revocation_reason TEXT,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  authorization_revision BIGINT NOT NULL CHECK (authorization_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_ref),
  CHECK (array_position(capabilities, NULL) IS NULL),
  CHECK (approved_at <= issued_at),
  CHECK (expires_at > issued_at),
  CHECK ((access_mode = 'read' AND expires_at <= issued_at + interval '15 minutes')
    OR (access_mode = 'write' AND expires_at <= issued_at + interval '5 minutes')),
  CHECK (access_mode <> 'write' OR approved_by <> issued_by),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL)),
  CHECK (revoked_by IS NULL OR (revoked_by = btrim(revoked_by) AND length(revoked_by) BETWEEN 1 AND 255 AND revoked_by !~ '[[:cntrl:]]')),
  CHECK (revocation_reason IS NULL OR (revocation_reason = btrim(revocation_reason) AND length(revocation_reason) BETWEEN 3 AND 1000 AND revocation_reason !~ '[[:cntrl:]]'))
);

CREATE INDEX IF NOT EXISTS ops_access_grants_subject_active_idx
  ON ops_access_grants (subject_identity_id, workspace_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS ops_access_grant_events (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES ops_access_grants(id),
  subject_identity_id UUID NOT NULL REFERENCES platform_identities(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('issued','used','revoked')),
  actor_id TEXT NOT NULL CHECK (actor_id = btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255 AND actor_id !~ '[[:cntrl:]]'),
  reason TEXT NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 1000 AND reason !~ '[[:cntrl:]]'),
  authorization_revision BIGINT NOT NULL CHECK (authorization_revision > 0),
  grant_revision INTEGER NOT NULL CHECK (grant_revision > 0),
  snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE authorization_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorization_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_role_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_role_assignment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_role_assignment_events FORCE ROW LEVEL SECURITY;
ALTER TABLE ops_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_access_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE ops_access_grant_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_access_grant_events FORCE ROW LEVEL SECURITY;

CREATE POLICY authorization_revisions_platform_ops ON authorization_revisions
  USING (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops');
CREATE POLICY platform_role_assignments_platform_ops ON platform_role_assignments
  USING (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops');
CREATE POLICY platform_role_assignment_events_platform_ops ON platform_role_assignment_events
  USING (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops');
CREATE POLICY ops_access_grants_platform_ops ON ops_access_grants
  USING (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops');
CREATE POLICY ops_access_grant_events_platform_ops ON ops_access_grant_events
  USING (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops');

REVOKE ALL ON authorization_revisions, platform_role_assignments, platform_role_assignment_events, ops_access_grants, ops_access_grant_events FROM PUBLIC;
DO $authorization_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON authorization_revisions, platform_role_assignments, platform_role_assignment_events, ops_access_grants, ops_access_grant_events FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON authorization_revisions, platform_role_assignments, platform_role_assignment_events, ops_access_grants, ops_access_grant_events FROM merchant_ops;
    GRANT SELECT, INSERT ON authorization_revisions, platform_role_assignments, platform_role_assignment_events, ops_access_grants, ops_access_grant_events TO merchant_ops;
    GRANT UPDATE (revision, updated_by, update_reason, updated_at) ON authorization_revisions TO merchant_ops;
    GRANT UPDATE (revoked_at, revoked_by, revocation_reason, revision, authorization_revision, updated_at) ON platform_role_assignments TO merchant_ops;
    GRANT UPDATE (use_count, revoked_at, revoked_by, revocation_reason, revision, authorization_revision, updated_at) ON ops_access_grants TO merchant_ops;
    REVOKE DELETE, TRUNCATE ON authorization_revisions, platform_role_assignments, platform_role_assignment_events, ops_access_grants, ops_access_grant_events FROM merchant_ops;
    REVOKE UPDATE, DELETE, TRUNCATE ON platform_role_assignment_events, ops_access_grant_events FROM merchant_ops;
  END IF;
END
$authorization_acl$;
