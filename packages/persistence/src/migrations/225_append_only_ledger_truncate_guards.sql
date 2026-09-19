-- 225_append_only_ledger_truncate_guards: close the owner-level TRUNCATE path
-- left open on 14 append-only ledgers.
--
-- Each of these tables already carries a `BEFORE UPDATE OR DELETE ... FOR EACH
-- ROW` rejection trigger, so UPDATE and DELETE are refused. A row-level trigger
-- is never fired by TRUNCATE, and TRUNCATE is gated by the TRUNCATE privilege
-- rather than DELETE, so a single statement from the table owner emptied the
-- whole ledger while the append-only contract still looked enforced. 224 closed
-- the same hole for `public_platform_rule_audits`; 132/134/136 are the sibling
-- statement-level guards. This migration brings the remaining ledgers in line.
--
-- `alert_webhook_receipts` is deliberately absent: 208 already installed
-- `alert_webhook_receipts_no_truncate BEFORE TRUNCATE ... FOR EACH STATEMENT`,
-- so it is not affected by this defect.

-- One shared function instead of fourteen near-identical copies. 134 already
-- shares a single function across two tables, and a single definition removes
-- the copy-paste drift that let these fourteen guards go missing in the first
-- place. TG_TABLE_SCHEMA/TG_TABLE_NAME keep the diagnostic per-table, so an
-- operator who gets 55000 is told exactly which ledger rejected the truncate.
CREATE OR REPLACE FUNCTION reject_append_only_ledger_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only ledger %.% rejects TRUNCATE',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000',
          HINT = 'Append-only ledgers cannot be emptied; record a new event instead.';
END;
$$;

DO $append_only_truncate_guards$
DECLARE
  target text;
  targets text[] := ARRAY[
    'asset_scan_receipts',
    'commercial_order_snapshots',
    'ops_incident_idempotency',
    'ops_incident_timeline',
    'platform_feature_flag_events',
    'platform_identity_events',
    'reconciliation_evidence',
    'support_sla_correction_approvals',
    'support_sla_correction_decisions',
    'support_sla_correction_runs',
    'support_sla_reporting_exclusions',
    'support_sla_reporting_results',
    'support_sla_reporting_runs',
    'workspace_support_ticket_events'
  ];
BEGIN
  FOREACH target IN ARRAY targets LOOP
    -- Only guard tables that are actually present, so the migration stays
    -- runnable if a deployment predates the table that introduced one of them.
    IF to_regclass(format('public.%I', target)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', target || '_no_truncate', target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_ledger_truncate()',
      target || '_no_truncate', target
    );
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM PUBLIC', target);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
      EXECUTE format('REVOKE TRUNCATE ON public.%I FROM merchant_app', target);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
      EXECUTE format('REVOKE TRUNCATE ON public.%I FROM merchant_ops', target);
    END IF;
  END LOOP;
END;
$append_only_truncate_guards$;
