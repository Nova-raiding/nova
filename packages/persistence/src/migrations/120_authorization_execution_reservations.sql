-- 120_authorization_execution_reservations: durable CAS fence for an
-- authorization-aware worker before a side-effect boundary.
-- This migration intentionally does not wire Worker or API entry points.
CREATE TABLE IF NOT EXISTS authorization_execution_reservations (
  reservation_id TEXT PRIMARY KEY
    CHECK (reservation_id = btrim(reservation_id) AND length(reservation_id) BETWEEN 1 AND 255 AND reservation_id !~ '[[:cntrl:]]'),
  event_id TEXT NOT NULL UNIQUE
    CHECK (event_id = btrim(event_id) AND length(event_id) BETWEEN 1 AND 255 AND event_id !~ '[[:cntrl:]]'),
  subject_identity_id UUID NOT NULL REFERENCES platform_identities(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  capability TEXT NOT NULL
    CHECK (capability = btrim(capability) AND length(capability) BETWEEN 1 AND 255 AND capability !~ '[[:cntrl:]]'),
  resource_id TEXT NOT NULL
    CHECK (resource_id = btrim(resource_id) AND length(resource_id) BETWEEN 1 AND 255 AND resource_id !~ '[[:cntrl:]]'),
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  grant_id UUID REFERENCES ops_access_grants(id),
  authorization_revision BIGINT NOT NULL CHECK (authorization_revision >= 0),
  grant_revision INTEGER,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((grant_id IS NULL AND grant_revision IS NULL)
    OR (grant_id IS NOT NULL AND grant_revision IS NOT NULL AND grant_revision > 0))
);

CREATE INDEX IF NOT EXISTS authorization_execution_reservations_subject_idx
  ON authorization_execution_reservations (subject_identity_id, workspace_id, reserved_at DESC);

ALTER TABLE authorization_execution_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorization_execution_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS authorization_execution_reservations_platform_ops ON authorization_execution_reservations;
CREATE POLICY authorization_execution_reservations_platform_ops ON authorization_execution_reservations
  USING (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops');

REVOKE ALL ON authorization_execution_reservations FROM PUBLIC;
DO $authorization_execution_reservation_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON authorization_execution_reservations FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT ON authorization_execution_reservations TO merchant_ops;
    REVOKE UPDATE, DELETE, TRUNCATE ON authorization_execution_reservations FROM merchant_ops;
  END IF;
END
$authorization_execution_reservation_acl$;
