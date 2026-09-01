BEGIN;
SELECT pg_advisory_xact_lock(731942852);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    CREATE ROLE merchant_app LOGIN PASSWORD 'merchant_app_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE merchant_app LOGIN PASSWORD 'merchant_app_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE merchant TO merchant_app;
GRANT USAGE ON SCHEMA public TO merchant_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO merchant_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO merchant_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM merchant_app;
-- This projection belongs to the isolated control-plane role. The broad
-- compatibility grant above must never re-expose it to the tenant role.
DO $$
BEGIN
  IF to_regclass('public.ops_workspace_summaries') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE ops_workspace_summaries FROM merchant_app';
  END IF;
  IF to_regclass('public.authorization_revisions') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON authorization_revisions, authorization_execution_reservations, platform_role_assignments, platform_role_assignment_events, ops_access_grants, ops_access_grant_events FROM merchant_app';
  END IF;
  IF to_regclass('public.platform_authorization_audit') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE platform_authorization_audit FROM merchant_app';
  END IF;
END
$$;
-- The broad compatibility grant above is deliberately followed by the
-- application-role delete deny list. RLS is not a substitute for least
-- privilege: these projections and durable execution records are never
-- deleted by the merchant runtime.
DO $$
BEGIN
  IF to_regclass('public.canonical_products') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE canonical_products FROM merchant_app';
  END IF;
  IF to_regclass('public.product_listings') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE product_listings FROM merchant_app';
  END IF;
  IF to_regclass('public.image_generation_executions') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE image_generation_executions FROM merchant_app';
  END IF;
  IF to_regclass('public.action_ledger') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE action_ledger FROM merchant_app';
  END IF;
  IF to_regclass('public.model_usage_ledger') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE model_usage_ledger FROM merchant_app';
  END IF;
  IF to_regclass('public.model_cost_budget_reservations') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE model_cost_budget_reservations FROM merchant_app';
  END IF;
  IF to_regclass('public.workspace_operation_audit') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE workspace_operation_audit FROM merchant_app';
  END IF;
  IF to_regclass('public.asset_scan_receipts') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE asset_scan_receipts FROM merchant_app';
  END IF;
  IF to_regclass('public.asset_scan_attempts') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE asset_scan_attempts FROM merchant_app';
  END IF;
  IF to_regclass('public.asset_promotion_cleanup_tasks') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE asset_promotion_cleanup_tasks FROM merchant_app';
  END IF;
  IF to_regclass('public.workspace_reconciliation_status') IS NOT NULL THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON TABLE workspace_reconciliation_status FROM merchant_app';
  END IF;
  IF to_regclass('public.reconciliation_evidence') IS NOT NULL THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE reconciliation_evidence FROM merchant_app';
  END IF;
  IF to_regclass('public.outbox_events') IS NOT NULL THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE outbox_events FROM merchant_app';
    EXECUTE 'GRANT UPDATE (published_at,attempts,next_attempt_at,lease_token,lease_until,last_error,unknown_at) ON TABLE outbox_events TO merchant_app';
  END IF;
  IF to_regclass('public.interactive_confirmation_tickets') IS NOT NULL THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE interactive_confirmation_tickets FROM merchant_app';
    EXECUTE 'GRANT UPDATE (consumed_at,consumed_operation_id,reservation_id,reservation_token,reserved_at,reservation_expires_at,reservation_revision) ON TABLE interactive_confirmation_tickets TO merchant_app';
  END IF;
  IF to_regclass('public.asset_scan_redrives') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE asset_scan_redrives FROM merchant_app';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE asset_scan_redrives TO merchant_app';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.worker_active_workspace_catalog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.worker_active_workspace_catalog() TO merchant_app;

-- The database owner may be provisioned separately in a local bootstrap.
-- Guard these defaults so role setup remains rerunnable without broadening
-- the runtime role or failing before the owner role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    ALTER DEFAULT PRIVILEGES FOR ROLE merchant IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO merchant_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE merchant IN SCHEMA public
      REVOKE DELETE, TRUNCATE ON TABLES FROM merchant_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE merchant IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO merchant_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE merchant IN SCHEMA public
      REVOKE EXECUTE ON FUNCTIONS FROM merchant_app;
  END IF;
END
$$;

-- The Ops control plane uses a distinct credential. It can reach only the
-- feature-flag catalog; tenant data continues through merchant_app + RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    CREATE ROLE merchant_ops LOGIN PASSWORD 'merchant_ops_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE merchant_ops LOGIN PASSWORD 'merchant_ops_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE merchant TO merchant_ops;
GRANT USAGE ON SCHEMA public TO merchant_ops;

-- Keep this bootstrap script usable by migrations <= 051. Later feature-flag
-- tables receive the same grants once they exist; older fresh databases must
-- not fail merely because those relations have not been created yet.
DO $$
BEGIN
  IF to_regclass('public.platform_feature_flags') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON platform_feature_flags, platform_feature_flag_targets, platform_feature_flag_events FROM merchant_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON platform_feature_flags, platform_feature_flag_targets TO merchant_ops';
    EXECUTE 'GRANT SELECT, INSERT ON platform_feature_flag_events TO merchant_ops';
  END IF;
END
$$;

-- The broad bootstrap grant above is intentionally followed by explicit
-- deny-by-default rules for platform media specs.  Merchant API code reads
-- only the approved projection; authoring specs and their audit trail belongs
-- to the separate merchant_ops credential.  This must run after migrations,
-- otherwise a fresh local database would silently widen the 066 ACL again.
DO $$
BEGIN
  IF to_regclass('public.platform_media_specs') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON platform_media_specs, platform_media_spec_audit, active_platform_media_specs FROM merchant_app';
    EXECUTE 'GRANT SELECT ON active_platform_media_specs TO merchant_app';
  END IF;
END
$$;

-- Durable authorization records are platform control-plane state. The broad
-- local compatibility grant near the top of this file must not expose them to
-- the tenant runtime role after migration 105 has created the tables.
DO $$
BEGIN
  IF to_regclass('public.authorization_revisions') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON authorization_revisions, authorization_execution_reservations, platform_role_assignments, platform_role_assignment_events, ops_access_grants, ops_access_grant_events FROM merchant_app';
  END IF;
  IF to_regclass('public.platform_authorization_audit') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE platform_authorization_audit FROM merchant_app';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE platform_authorization_audit TO merchant_ops';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE platform_authorization_audit FROM merchant_ops';
  END IF;
END
$$;

COMMIT;
