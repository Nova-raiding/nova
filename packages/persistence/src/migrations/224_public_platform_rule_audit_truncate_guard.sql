-- 224_public_platform_rule_audit_truncate_guard: close the owner-level
-- mutation path left by the 219 append-only contract.
--
-- 219 installed only a `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger on
-- `public_platform_rule_audits`. A row-level trigger is never fired by
-- TRUNCATE, and TRUNCATE needs the TRUNCATE privilege rather than DELETE, so
-- the owner of the table could empty the whole platform rule audit ledger with
-- a single statement while `UPDATE`/`DELETE` stayed rejected. The sibling
-- ledgers already carry the statement-level guard this migration adds
-- (`reject_rule_audit_mutation` in 132, the workspace audit guard in 136), and
-- the error code is the same 55000 append-only contract.

CREATE OR REPLACE FUNCTION reject_public_platform_rule_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'public platform rule audits are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS public_platform_rule_audits_no_truncate
  ON public_platform_rule_audits;
CREATE TRIGGER public_platform_rule_audits_no_truncate
BEFORE TRUNCATE ON public_platform_rule_audits
FOR EACH STATEMENT EXECUTE FUNCTION reject_public_platform_rule_audit_mutation();

REVOKE TRUNCATE ON public_platform_rule_audits FROM PUBLIC;
DO $public_platform_rule_audit_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE TRUNCATE ON public_platform_rule_audits FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE TRUNCATE ON public_platform_rule_audits FROM merchant_ops;
  END IF;
END
$public_platform_rule_audit_acl$;
