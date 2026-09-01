-- 144_creative_point_ledger: tenant-scoped creative-point facts and the
-- concurrency fence used by grant/reserve/release/settle transactions.
-- This migration only creates the new ledger objects and does not transform
-- pre-existing application data.

CREATE TABLE creative_point_access_state (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  available_points BIGINT,
  reserved_points BIGINT,
  settled_points BIGINT,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (available_points IS NULL OR available_points >= 0),
  CHECK (reserved_points IS NULL OR reserved_points >= 0),
  CHECK (settled_points IS NULL OR settled_points >= 0)
);

CREATE TABLE creative_point_operations (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('grant', 'reserve', 'release', 'settle')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'rejected')),
  request JSONB NOT NULL,
  result JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, kind, idempotency_key),
  CHECK ((status = 'pending' AND completed_at IS NULL)
      OR (status IN ('completed', 'rejected') AND completed_at IS NOT NULL))
);

CREATE TABLE creative_point_grants (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  points BIGINT NOT NULL CHECK (points > 0),
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, source_type, source_id),
  CONSTRAINT creative_point_grants_operation_fk
    FOREIGN KEY (workspace_id, operation_id)
    REFERENCES creative_point_operations(workspace_id, id)
);

CREATE TABLE creative_point_reservations (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  points BIGINT NOT NULL CHECK (points > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'settled')),
  settled_points BIGINT CHECK (settled_points IS NULL OR settled_points >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, operation_id),
  CONSTRAINT creative_point_reservations_operation_fk
    FOREIGN KEY (workspace_id, operation_id)
    REFERENCES creative_point_operations(workspace_id, id),
  CHECK ((status = 'active' AND finalized_at IS NULL AND settled_points IS NULL)
      OR (status = 'released' AND finalized_at IS NOT NULL AND settled_points IS NULL)
      OR (status = 'settled' AND finalized_at IS NOT NULL AND settled_points IS NOT NULL))
);

CREATE TABLE creative_point_allocations (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  allocation_type TEXT NOT NULL CHECK (allocation_type IN ('reserve', 'release', 'settle_adjustment')),
  points_delta BIGINT NOT NULL CHECK (points_delta <> 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT creative_point_allocations_reservation_fk
    FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES creative_point_reservations(workspace_id, id),
  CONSTRAINT creative_point_allocations_grant_fk
    FOREIGN KEY (workspace_id, grant_id)
    REFERENCES creative_point_grants(workspace_id, id)
);

CREATE TABLE creative_point_ledger_events (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'reserved', 'released', 'settled')),
  points_delta BIGINT NOT NULL,
  available_after BIGINT,
  reserved_after BIGINT,
  settled_after BIGINT,
  access_revision BIGINT NOT NULL CHECK (access_revision > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, access_revision),
  CONSTRAINT creative_point_ledger_operation_fk
    FOREIGN KEY (workspace_id, operation_id)
    REFERENCES creative_point_operations(workspace_id, id),
  CHECK (available_after IS NULL OR available_after >= 0),
  CHECK (reserved_after IS NULL OR reserved_after >= 0),
  CHECK (settled_after IS NULL OR settled_after >= 0)
);

CREATE INDEX creative_point_grants_workspace_expiry_idx
  ON creative_point_grants(workspace_id, expires_at, created_at, id);
CREATE INDEX creative_point_reservations_workspace_status_idx
  ON creative_point_reservations(workspace_id, status, created_at, id);
CREATE INDEX creative_point_allocations_grant_idx
  ON creative_point_allocations(workspace_id, grant_id);
CREATE INDEX creative_point_allocations_reservation_idx
  ON creative_point_allocations(workspace_id, reservation_id, created_at, id);
CREATE INDEX creative_point_ledger_workspace_created_idx
  ON creative_point_ledger_events(workspace_id, created_at, id);

DO $creative_point_rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'creative_point_access_state',
    'creative_point_operations',
    'creative_point_grants',
    'creative_point_reservations',
    'creative_point_allocations',
    'creative_point_ledger_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      table_name || '_workspace_isolation',
      table_name
    );
  END LOOP;
END
$creative_point_rls$;

CREATE OR REPLACE FUNCTION reject_creative_point_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'creative point facts are append-only' USING ERRCODE = '55000';
END;
$$;

DO $creative_point_immutable$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'creative_point_grants',
    'creative_point_allocations',
    'creative_point_ledger_events'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_creative_point_fact_mutation()', table_name || '_append_only', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_creative_point_fact_mutation()', table_name || '_no_truncate', table_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM PUBLIC', table_name);
  END LOOP;
END
$creative_point_immutable$;

DO $creative_point_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON creative_point_operations, creative_point_grants,
      creative_point_reservations, creative_point_allocations,
      creative_point_ledger_events TO merchant_app;
    GRANT SELECT, INSERT, UPDATE ON creative_point_access_state,
      creative_point_operations, creative_point_reservations TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON creative_point_grants,
      creative_point_allocations, creative_point_ledger_events FROM merchant_app;
    REVOKE DELETE, TRUNCATE ON creative_point_access_state,
      creative_point_operations, creative_point_reservations FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON creative_point_access_state, creative_point_operations,
      creative_point_grants, creative_point_reservations,
      creative_point_allocations, creative_point_ledger_events TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON creative_point_access_state,
      creative_point_operations, creative_point_grants,
      creative_point_reservations, creative_point_allocations,
      creative_point_ledger_events FROM merchant_ops;
  END IF;
END
$creative_point_acl$;
