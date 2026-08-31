-- 096_reconciliation_evidence: immutable, per-provider-query reconciliation evidence.
CREATE TABLE IF NOT EXISTS reconciliation_evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  job_id TEXT NOT NULL,
  execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
  provider_request_id TEXT NOT NULL,
  query_attempt INTEGER NOT NULL CHECK (query_attempt > 0),
  idempotency_key TEXT NOT NULL,
  provider_state TEXT NOT NULL CHECK (provider_state IN ('processing','succeeded','failed','unknown')),
  provider_status TEXT,
  response_digest TEXT,
  artifact_digest TEXT,
  usage_ledger_id TEXT,
  action_ledger_id TEXT,
  usage JSONB,
  cost JSONB,
  observed_at TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_evidence_idempotency_unique UNIQUE (workspace_id,idempotency_key),
  CONSTRAINT reconciliation_evidence_job_fk FOREIGN KEY (workspace_id,job_id) REFERENCES image_generation_jobs(workspace_id,id),
  CONSTRAINT reconciliation_evidence_failure_details CHECK ((provider_state = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL) OR (provider_state <> 'failed' AND error_code IS NULL AND error_message IS NULL)),
  CONSTRAINT reconciliation_evidence_json_objects CHECK ((usage IS NULL OR jsonb_typeof(usage) = 'object') AND (cost IS NULL OR jsonb_typeof(cost) = 'object'))
);
CREATE INDEX IF NOT EXISTS reconciliation_evidence_workspace_created_idx ON reconciliation_evidence (workspace_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS reconciliation_evidence_workspace_job_idx ON reconciliation_evidence (workspace_id,job_id,created_at DESC,id DESC);
ALTER TABLE reconciliation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconciliation_evidence_workspace_isolation ON reconciliation_evidence;
CREATE POLICY reconciliation_evidence_workspace_isolation ON reconciliation_evidence USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE OR REPLACE FUNCTION reject_reconciliation_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $reconciliation_evidence_append_only$ BEGIN RAISE EXCEPTION 'reconciliation evidence is append-only' USING ERRCODE = '55000'; END; $reconciliation_evidence_append_only$;
DROP TRIGGER IF EXISTS reconciliation_evidence_append_only ON reconciliation_evidence;
CREATE TRIGGER reconciliation_evidence_append_only BEFORE UPDATE OR DELETE ON reconciliation_evidence FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_evidence_mutation();
REVOKE ALL ON TABLE reconciliation_evidence FROM PUBLIC;
DO $reconciliation_evidence_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT,INSERT ON TABLE reconciliation_evidence TO merchant_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON TABLE reconciliation_evidence FROM merchant_app;
  END IF;
END
$reconciliation_evidence_grants$;
