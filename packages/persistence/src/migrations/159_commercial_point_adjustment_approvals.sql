CREATE TABLE commercial_point_adjustment_proposals_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  points_delta BIGINT NOT NULL CHECK (points_delta <> 0),
  expected_access_revision BIGINT NOT NULL CHECK (expected_access_revision >= 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence JSONB NOT NULL CHECK (evidence <> '{}'::jsonb),
  expires_at TIMESTAMPTZ,
  proposed_by_actor_id TEXT NOT NULL CHECK (length(trim(proposed_by_actor_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (points_delta > 0 OR expires_at IS NULL),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE commercial_point_adjustment_decisions_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence JSONB NOT NULL CHECK (evidence <> '{}'::jsonb),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, proposal_id),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT commercial_point_adjustment_decisions_proposal_fk
    FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES commercial_point_adjustment_proposals_v2(workspace_id, id)
);

CREATE OR REPLACE FUNCTION reject_commercial_point_adjustment_approval_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commercial point adjustment approval facts are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION require_distinct_commercial_point_adjustment_approver()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commercial_point_adjustment_proposals_v2 proposal
    WHERE proposal.workspace_id = NEW.workspace_id
      AND proposal.id = NEW.proposal_id
      AND proposal.proposed_by_actor_id = NEW.actor_id
  ) THEN
    RAISE EXCEPTION 'commercial point adjustment maker cannot approve own proposal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commercial_point_adjustment_distinct_approver
BEFORE INSERT ON commercial_point_adjustment_decisions_v2
FOR EACH ROW EXECUTE FUNCTION require_distinct_commercial_point_adjustment_approver();

DO $commercial_point_adjustment_approval_security$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['commercial_point_adjustment_proposals_v2', 'commercial_point_adjustment_decisions_v2'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))', table_name || '_workspace_isolation', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_commercial_point_adjustment_approval_mutation()', table_name || '_append_only', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_point_adjustment_approval_mutation()', table_name || '_no_truncate', table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', table_name);
  END LOOP;
END
$commercial_point_adjustment_approval_security$;

DO $commercial_point_adjustment_approval_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON commercial_point_adjustment_proposals_v2, commercial_point_adjustment_decisions_v2 TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON commercial_point_adjustment_proposals_v2, commercial_point_adjustment_decisions_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT ON commercial_point_adjustment_proposals_v2, commercial_point_adjustment_decisions_v2 TO merchant_ops;
    REVOKE UPDATE, DELETE, TRUNCATE ON commercial_point_adjustment_proposals_v2, commercial_point_adjustment_decisions_v2 FROM merchant_ops;
  END IF;
END
$commercial_point_adjustment_approval_acl$;
