CREATE TABLE IF NOT EXISTS support_sla_correction_decisions (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  correction_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 1000),
  actor_id TEXT NOT NULL CHECK (btrim(actor_id) <> ''),
  idempotency_key TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, decision_id),
  UNIQUE (workspace_id, correction_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, correction_id) REFERENCES support_sla_correction_runs(workspace_id, correction_id)
);

ALTER TABLE support_sla_correction_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sla_correction_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY support_sla_correction_decisions_workspace_isolation ON support_sla_correction_decisions USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_support_sla_correction_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $support_sla_correction_decision_immutable$
BEGIN
  RAISE EXCEPTION 'support SLA correction decisions are immutable' USING ERRCODE = '55000';
END;
$support_sla_correction_decision_immutable$;

CREATE TRIGGER support_sla_correction_decisions_immutable BEFORE UPDATE OR DELETE ON support_sla_correction_decisions FOR EACH ROW EXECUTE FUNCTION reject_support_sla_correction_decision_mutation();

REVOKE ALL ON TABLE support_sla_correction_decisions FROM PUBLIC;
DO $support_sla_correction_decision_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON TABLE support_sla_correction_decisions TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE support_sla_correction_decisions FROM merchant_app;
  END IF;
END
$support_sla_correction_decision_acl$;
