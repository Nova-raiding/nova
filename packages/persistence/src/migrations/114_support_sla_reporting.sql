CREATE TABLE IF NOT EXISTS support_sla_reporting_runs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  report_id TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  cutoff_at TIMESTAMPTZ NOT NULL,
  policy_versions_json JSONB NOT NULL,
  calendar_versions_json JSONB NOT NULL,
  denominator INTEGER NOT NULL CHECK (denominator >= 0),
  met INTEGER NOT NULL CHECK (met >= 0 AND met <= denominator),
  failed INTEGER NOT NULL CHECK (failed >= 0 AND failed <= denominator),
  excluded INTEGER NOT NULL CHECK (excluded >= 0),
  late_or_unresolved INTEGER NOT NULL CHECK (late_or_unresolved >= 0 AND late_or_unresolved = failed),
  checksum TEXT NOT NULL CHECK (checksum = btrim(checksum) AND length(checksum) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, report_id),
  UNIQUE (workspace_id, period_start, checksum),
  CHECK (period_end > period_start),
  CHECK (jsonb_typeof(policy_versions_json) = 'array'),
  CHECK (jsonb_typeof(calendar_versions_json) = 'array')
);

CREATE TABLE IF NOT EXISTS support_sla_reporting_results (
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('met','failed','excluded')),
  terminal_at TIMESTAMPTZ,
  exclusion TEXT CHECK (exclusion IN ('contract_na','merged_duplicate_before_first_response','test_ticket')),
  PRIMARY KEY (workspace_id, report_id, ticket_id),
  FOREIGN KEY (workspace_id, report_id) REFERENCES support_sla_reporting_runs(workspace_id, report_id)
);

CREATE TABLE IF NOT EXISTS support_sla_reporting_exclusions (
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  exclusion TEXT NOT NULL CHECK (exclusion IN ('contract_na','merged_duplicate_before_first_response','test_ticket')),
  PRIMARY KEY (workspace_id, report_id, ticket_id),
  FOREIGN KEY (workspace_id, report_id, ticket_id) REFERENCES support_sla_reporting_results(workspace_id, report_id, ticket_id)
);

CREATE TABLE IF NOT EXISTS support_sla_correction_runs (
  workspace_id TEXT NOT NULL,
  correction_id TEXT NOT NULL,
  original_report_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 1000),
  source_checksum TEXT NOT NULL CHECK (length(source_checksum) = 64),
  corrected_checksum TEXT NOT NULL CHECK (length(corrected_checksum) = 64),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'pending_review'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, correction_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, original_report_id) REFERENCES support_sla_reporting_runs(workspace_id, report_id),
  CHECK (source_checksum <> corrected_checksum)
);

ALTER TABLE support_sla_reporting_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sla_reporting_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY support_sla_reporting_runs_workspace_isolation ON support_sla_reporting_runs USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE support_sla_reporting_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sla_reporting_results FORCE ROW LEVEL SECURITY;
CREATE POLICY support_sla_reporting_results_workspace_isolation ON support_sla_reporting_results USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE support_sla_reporting_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sla_reporting_exclusions FORCE ROW LEVEL SECURITY;
CREATE POLICY support_sla_reporting_exclusions_workspace_isolation ON support_sla_reporting_exclusions USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE support_sla_correction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sla_correction_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY support_sla_correction_runs_workspace_isolation ON support_sla_correction_runs USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_support_sla_reporting_mutation()
RETURNS trigger LANGUAGE plpgsql AS $support_sla_reporting_immutable$
BEGIN
  RAISE EXCEPTION 'support SLA reporting evidence is immutable' USING ERRCODE = '55000';
END;
$support_sla_reporting_immutable$;

CREATE TRIGGER support_sla_reporting_runs_immutable BEFORE UPDATE OR DELETE ON support_sla_reporting_runs FOR EACH ROW EXECUTE FUNCTION reject_support_sla_reporting_mutation();
CREATE TRIGGER support_sla_reporting_results_immutable BEFORE UPDATE OR DELETE ON support_sla_reporting_results FOR EACH ROW EXECUTE FUNCTION reject_support_sla_reporting_mutation();
CREATE TRIGGER support_sla_reporting_exclusions_immutable BEFORE UPDATE OR DELETE ON support_sla_reporting_exclusions FOR EACH ROW EXECUTE FUNCTION reject_support_sla_reporting_mutation();
CREATE TRIGGER support_sla_correction_runs_immutable BEFORE UPDATE OR DELETE ON support_sla_correction_runs FOR EACH ROW EXECUTE FUNCTION reject_support_sla_reporting_mutation();

REVOKE ALL ON TABLE support_sla_reporting_runs, support_sla_reporting_results, support_sla_reporting_exclusions, support_sla_correction_runs FROM PUBLIC;
DO $support_sla_reporting_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON TABLE support_sla_reporting_runs, support_sla_reporting_results, support_sla_reporting_exclusions, support_sla_correction_runs TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE support_sla_reporting_runs, support_sla_reporting_results, support_sla_reporting_exclusions, support_sla_correction_runs FROM merchant_app;
  END IF;
END
$support_sla_reporting_acl$;
