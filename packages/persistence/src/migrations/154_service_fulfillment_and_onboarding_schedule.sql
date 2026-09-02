-- 154_service_fulfillment_and_onboarding_schedule: tenant-scoped service
-- allocations, append-only fulfillment evidence, and the non-executable
-- six-by-500 onboarding grant schedule draft required by the source PRD.

CREATE TABLE workspace_service_allocations (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  order_snapshot_id TEXT NOT NULL,
  entitlement_snapshot_id TEXT NOT NULL,
  service_type TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('count', 'minute', 'contract_label')),
  allocated_quantity BIGINT CHECK (allocated_quantity IS NULL OR allocated_quantity >= 0),
  contract_label TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  source_checksum TEXT NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  created_by_actor_id TEXT NOT NULL,
  creation_reason TEXT NOT NULL CHECK (length(trim(creation_reason)) > 0),
  creation_evidence JSONB NOT NULL CHECK (creation_evidence <> '{}'::jsonb),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'allocated' CHECK (status IN ('allocated', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  used_quantity BIGINT NOT NULL DEFAULT 0 CHECK (used_quantity >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, id, revision),
  CHECK ((unit = 'contract_label' AND contract_label IS NOT NULL AND allocated_quantity IS NULL)
      OR (unit IN ('count', 'minute') AND contract_label IS NULL AND allocated_quantity IS NOT NULL)),
  CHECK ((period_start IS NULL AND period_end IS NULL) OR (period_start IS NOT NULL AND period_end > period_start)),
  CHECK (allocated_quantity IS NULL OR used_quantity <= allocated_quantity)
);

CREATE TABLE workspace_service_fulfillment_events (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  allocation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('scheduled', 'started', 'completed', 'cancelled', 'adjusted')),
  revision BIGINT NOT NULL CHECK (revision > 1),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  schedule_at TIMESTAMPTZ,
  actual_quantity BIGINT CHECK (actual_quantity IS NULL OR actual_quantity >= 0),
  corrects_event_id TEXT,
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  allocation_after JSONB NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, allocation_id, revision),
  UNIQUE (workspace_id, corrects_event_id),
  CONSTRAINT service_event_allocation_fk FOREIGN KEY (workspace_id, allocation_id)
    REFERENCES workspace_service_allocations(workspace_id, id),
  CONSTRAINT service_event_correction_fk FOREIGN KEY (workspace_id, corrects_event_id)
    REFERENCES workspace_service_fulfillment_events(workspace_id, id),
  CHECK (event_type <> 'scheduled' OR schedule_at IS NOT NULL),
  CHECK (event_type <> 'adjusted' OR (corrects_event_id IS NOT NULL AND actual_quantity IS NOT NULL)),
  CHECK (event_type = 'adjusted' OR corrects_event_id IS NULL),
  CHECK (event_type <> 'completed' OR evidence <> '{}'::jsonb)
);

-- Migration 153 owns the contract-level schedule table. This forward layer
-- adds the exact source snapshot and blocker evidence needed by fulfillment;
-- it does not create a second schedule or activate the unresolved rows.
ALTER TABLE onboarding_point_grant_schedules_v2
  ADD COLUMN entitlement_snapshot_id TEXT,
  ADD COLUMN blockers JSONB NOT NULL DEFAULT '["ONBOARDING_GRANT_START_DATE_UNRESOLVED","ONBOARDING_GRANT_EXPIRY_RULE_UNRESOLVED"]'::jsonb,
  ADD COLUMN source_checksum TEXT CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  ADD COLUMN created_by_actor_id TEXT,
  ADD COLUMN creation_reason TEXT,
  ADD COLUMN creation_evidence JSONB;

CREATE INDEX service_allocations_workspace_updated_idx ON workspace_service_allocations(workspace_id, updated_at DESC, id DESC);
CREATE INDEX service_events_workspace_allocation_idx ON workspace_service_fulfillment_events(workspace_id, allocation_id, revision);
CREATE INDEX onboarding_grant_schedule_workspace_order_evidence_idx ON onboarding_point_grant_schedules_v2(workspace_id, onboarding_order_id, sequence) INCLUDE (entitlement_snapshot_id, source_checksum);

DO $service_fulfillment_rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspace_service_allocations','workspace_service_fulfillment_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))', table_name || '_workspace_isolation', table_name);
  END LOOP;
END
$service_fulfillment_rls$;

CREATE OR REPLACE FUNCTION reject_service_fulfillment_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service fulfillment facts are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER workspace_service_fulfillment_events_append_only BEFORE UPDATE OR DELETE ON workspace_service_fulfillment_events FOR EACH ROW EXECUTE FUNCTION reject_service_fulfillment_fact_mutation();
CREATE TRIGGER workspace_service_fulfillment_events_no_truncate BEFORE TRUNCATE ON workspace_service_fulfillment_events FOR EACH STATEMENT EXECUTE FUNCTION reject_service_fulfillment_fact_mutation();
CREATE TRIGGER onboarding_point_grant_schedules_v2_append_only_unresolved BEFORE UPDATE OR DELETE ON onboarding_point_grant_schedules_v2 FOR EACH ROW EXECUTE FUNCTION reject_service_fulfillment_fact_mutation();
CREATE TRIGGER onboarding_point_grant_schedules_v2_no_truncate_unresolved BEFORE TRUNCATE ON onboarding_point_grant_schedules_v2 FOR EACH STATEMENT EXECUTE FUNCTION reject_service_fulfillment_fact_mutation();

DO $service_fulfillment_acl$
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE ON workspace_service_fulfillment_events, onboarding_point_grant_schedules_v2 FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON workspace_service_allocations, workspace_service_fulfillment_events FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT ON workspace_service_allocations, workspace_service_fulfillment_events TO merchant_ops;
    GRANT UPDATE (revision, status, used_quantity, updated_at) ON workspace_service_allocations TO merchant_ops;
    REVOKE DELETE, TRUNCATE ON workspace_service_allocations, workspace_service_fulfillment_events, onboarding_point_grant_schedules_v2 FROM merchant_ops;
    REVOKE UPDATE ON workspace_service_fulfillment_events, onboarding_point_grant_schedules_v2 FROM merchant_ops;
  END IF;
END
$service_fulfillment_acl$;
