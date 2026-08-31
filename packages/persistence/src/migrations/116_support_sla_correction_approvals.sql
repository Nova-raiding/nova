CREATE TABLE IF NOT EXISTS support_sla_correction_approvals (
  workspace_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  correction_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 1000),
  actor_id TEXT NOT NULL CHECK (btrim(actor_id) <> ''),
  idempotency_key TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, approval_id),
  UNIQUE (workspace_id, correction_id, actor_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, correction_id) REFERENCES support_sla_correction_runs(workspace_id, correction_id)
);

ALTER TABLE support_sla_correction_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sla_correction_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY support_sla_correction_approvals_workspace_isolation ON support_sla_correction_approvals USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_support_sla_correction_approval_mutation()
RETURNS trigger LANGUAGE plpgsql AS $support_sla_correction_approval_immutable$
BEGIN
  RAISE EXCEPTION 'support SLA correction approvals are immutable' USING ERRCODE = '55000';
END;
$support_sla_correction_approval_immutable$;

CREATE TRIGGER support_sla_correction_approvals_immutable BEFORE UPDATE OR DELETE ON support_sla_correction_approvals FOR EACH ROW EXECUTE FUNCTION reject_support_sla_correction_approval_mutation();
REVOKE ALL ON TABLE support_sla_correction_approvals FROM PUBLIC;
DO $support_sla_correction_approval_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON TABLE support_sla_correction_approvals TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE support_sla_correction_approvals FROM merchant_app;
  END IF;
END
$support_sla_correction_approval_acl$;
