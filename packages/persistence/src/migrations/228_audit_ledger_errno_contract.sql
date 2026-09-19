-- 228_audit_ledger_errno_contract: give the two remaining append-only ledgers
-- the same SQLSTATE as the rest of the family.
--
-- `platform_identity_events` (045) and `platform_feature_flag_events` (057)
-- reject row mutations with a bare `RAISE EXCEPTION`, which defaults to
-- SQLSTATE P0001. Every sibling ledger rejects with 55000 (132 rule audits,
-- 136 workspace audit, 184 knowledge ledgers, 219/224 platform rule audits,
-- 225/226 truncate guards, 227 media spec audit).
--
-- P0001 is the default for *any* plpgsql `RAISE EXCEPTION`, so an operator or a
-- caller cannot tell an append-only violation apart from an unrelated
-- procedural error — the failure mode is indistinguishable exactly where the
-- ledger contract is the thing being enforced. The sibling code is not
-- cosmetic: it is what makes "this ledger is append-only" a recognisable
-- outcome.
--
-- Only the function bodies change. `CREATE OR REPLACE FUNCTION` keeps the
-- function OID, so the existing triggers stay bound and no trigger is dropped
-- or recreated; the bodies are otherwise identical to 045/057. Nothing on these
-- two tables depends on P0001 — the only P0001 assertions in the repository
-- target `sync_enterprise_name_for_workspaces` (193) and a deliberately
-- injected test trigger (migration-212), neither of which reads these tables.

CREATE OR REPLACE FUNCTION reject_platform_identity_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform identity events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION reject_feature_flag_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_feature_flag_events is immutable' USING ERRCODE = '55000';
END;
$$;
