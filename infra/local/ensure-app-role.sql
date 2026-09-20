-- ROLE PASSWORDS ARE SET ONLY WHEN THE ROLE IS CREATED.
--
-- This file is not local-only: the ECS production chain mounts it into the
-- migrate service (infra/local/docker-compose.ecs-production-migration.yml) and
-- runs it before and after every migration. The CREATE branch below is the
-- local acceptance identity, and re-running it locally is a no-op because the
-- role already holds that password. The ELSE branch used to `ALTER ROLE ...
-- PASSWORD '<local value>'` as well, which meant a deploy against a database
-- whose runtime credentials were provisioned out of band (the only shape
-- `deploy-preflight-ecs.sh` and validate-ecs-production-compose.mjs accept)
-- silently reset merchant_app/merchant_ops/merchant_alert_receiver to the
-- passwords published in this repository, after which the API's own
-- DATABASE_URL could no longer authenticate. An existing role keeps its
-- credential and only has its privilege attributes normalized here.
BEGIN;
SELECT pg_advisory_xact_lock(731942852);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    CREATE ROLE merchant_app LOGIN PASSWORD 'merchant_app_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE merchant_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- The alert receiver is a separate trust domain from both the tenant runtime
-- and the Ops control plane. This password is intentionally local-only;
-- production provisioning must create the role and credential out of band.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_alert_receiver') THEN
    CREATE ROLE merchant_alert_receiver LOGIN PASSWORD 'merchant_alert_receiver_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE merchant_alert_receiver NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE merchant TO merchant_alert_receiver;
GRANT USAGE ON SCHEMA public TO merchant_alert_receiver;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM merchant_alert_receiver;

DO $$
BEGIN
  IF to_regclass('public.workspace_service_allocations') IS NOT NULL THEN
    REVOKE ALL ON TABLE workspace_service_allocations, workspace_service_fulfillment_events FROM merchant_app;
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
DECLARE
  relation_name TEXT;
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
  -- Migrations 067/068/079/218 each revoked DELETE from merchant_app on these
  -- tables and granted back only SELECT/INSERT/UPDATE, because they hold audit
  -- and control-plane records the runtime must not destroy: manual publish
  -- reports, batch campaign plans, frozen context/task snapshots, export
  -- requests, private-trial invites, orphan-reconciliation rows and the
  -- preflight approvals. The blanket grant at the top of this file puts DELETE
  -- back, and none of them carries a BEFORE DELETE trigger, so the revocation
  -- was only ever true until the bootstrap re-ran. Verified before adding: no
  -- production call site issues DELETE against any of them (only migrations,
  -- tests and retention tooling do), so this removes a permission nothing uses.
  FOREACH relation_name IN ARRAY ARRAY[
    'manual_publish_evidence',
    'batch_campaigns',
    'batch_campaign_items',
    'context_snapshots',
    'task_snapshots',
    'knowledge_hydration_snapshots',
    'object_storage_orphans',
    'platform_mapping_preflight_approvals',
    'workspace_data_export_requests',
    'private_trial_invites_v2',
    'workspace_growth_events',
    'workspace_usage_ledger'
  ] LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE DELETE ON TABLE %I FROM merchant_app', relation_name);
    END IF;
  END LOOP;
END
$$;
-- `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM merchant_app` above is
-- deliberately blanket, so every SECURITY DEFINER entry point the runtime is
-- allowed to call has to be re-granted after it. Migration 223 adds the
-- capability-trimmed commercial catalog projection; like the 051 worker
-- catalog it is useless without this re-grant, because the deployed migrate
-- entrypoint runs this script again *after* the migration chain.
DO $$
BEGIN
  IF to_regprocedure('public.worker_active_workspace_catalog()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.worker_active_workspace_catalog() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.worker_active_workspace_catalog() TO merchant_app;
  END IF;

  IF to_regprocedure('public.merchant_entitlement_snapshots_v2(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.merchant_entitlement_snapshots_v2(integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.merchant_entitlement_snapshots_v2(integer) TO merchant_app;
  END IF;

  IF to_regprocedure('public.merchant_onboarding_sku_v2()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.merchant_onboarding_sku_v2() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.merchant_onboarding_sku_v2() TO merchant_app;
  END IF;
END
$$;

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
    -- Same rule as the other two roles: normalize the attributes, never the
    -- credential. See the header note.
    ALTER ROLE merchant_ops NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE merchant TO merchant_ops;
GRANT USAGE ON SCHEMA public TO merchant_ops;

-- Keep this bootstrap script usable by migrations <= 051. Later feature-flag
-- tables receive the same grants once they exist; older fresh databases must
-- not fail merely because those relations have not been created yet.
DO $$
DECLARE
  relation_name TEXT;
BEGIN
  -- These identity relations are introduced across several migrations. Do
  -- not let a historical-prefix bootstrap fail merely because a later table
  -- is absent; revoke each relation only after checking that it exists.
  FOREACH relation_name IN ARRAY ARRAY[
    'platform_identities', 'platform_identity_events', 'platform_auth_sessions',
    'platform_password_accounts', 'platform_password_sessions', 'platform_password_reset_tokens',
    'mcp_oauth_authorization_codes', 'mcp_oauth_tokens'
  ] LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM merchant_app', relation_name);
    END IF;
  END LOOP;
  IF to_regclass('public.enterprises') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON enterprises FROM merchant_app';
    EXECUTE 'GRANT SELECT ON enterprises TO merchant_ops';
  END IF;
  IF to_regclass('public.platform_feature_flags') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON platform_feature_flags, platform_feature_flag_targets, platform_feature_flag_events FROM merchant_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON platform_feature_flags, platform_feature_flag_targets TO merchant_ops';
    EXECUTE 'GRANT SELECT, INSERT ON platform_feature_flag_events TO merchant_ops';
  END IF;
END
$$;

-- Global control-plane and commercial configuration are not tenant-runtime
-- write surfaces. This block must remain after the broad compatibility grant
-- above and is intentionally idempotent for every local migrate run.
DO $$
BEGIN
  IF to_regclass('public.platform_feature_flags') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON platform_feature_flags, platform_feature_flag_targets, platform_feature_flag_events FROM merchant_app';
  END IF;
  IF to_regclass('public.enterprises') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON enterprises FROM merchant_app';
    EXECUTE 'GRANT SELECT ON enterprises TO merchant_ops';
  END IF;
  IF to_regclass('public.model_markup_policy') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON model_markup_policy FROM merchant_app';
  END IF;
  IF to_regclass('public.platform_media_specs') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON platform_media_specs, platform_media_spec_audit, active_platform_media_specs FROM merchant_app';
    EXECUTE 'GRANT SELECT ON active_platform_media_specs TO merchant_app';
  END IF;
  IF to_regclass('public.commercial_catalog_skus') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_catalog_skus, commercial_catalog_sku_versions, commercial_catalog_sku_benefits, creative_point_rate_card_versions_v2, creative_point_rate_rules_v2, commercial_catalog_events_v2, commercial_offers, commercial_addons, commercial_coupons, commercial_rollouts FROM merchant_app';
  END IF;
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM merchant_app';
  END IF;
  IF to_regclass('public.knowledge_index_events') IS NOT NULL THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON knowledge_index_events, knowledge_deletion_proofs FROM merchant_app';
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

DO $$
BEGIN
  IF to_regclass('public.workspace_service_allocations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE workspace_service_allocations, workspace_service_fulfillment_events FROM merchant_app';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE workspace_service_allocations, workspace_service_fulfillment_events FROM merchant_ops';
    EXECUTE 'GRANT SELECT ON TABLE workspace_service_allocations, workspace_service_fulfillment_events TO merchant_ops';
  END IF;
END
$$;

-- Do not undo customer-delivery control-plane ACLs when this compatibility
-- bootstrap is rerun after migrations. Check separately for prefix databases.
DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'workspace_customer_deliveries', 'workspace_customer_delivery_videos',
    'workspace_customer_delivery_checklist_items'
  ] LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM merchant_app', relation_name);
    END IF;
  END LOOP;
END $$;

-- Re-apply the alert-receiver boundary after the broad merchant_app
-- compatibility grant. The receiver never receives direct table privileges;
-- it can only use the two SECURITY DEFINER functions installed by migration
-- 209. Keep this block prefix-safe so bootstrap can run before that migration.
DO $$
BEGIN
  IF to_regclass('public.alert_webhook_receipts') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.alert_webhook_receipts FROM PUBLIC, merchant_app, merchant_ops, merchant_alert_receiver';
  END IF;

  IF to_regprocedure('public.append_alert_webhook_receipt(text,text,timestamp with time zone,timestamp with time zone,text,jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb)
      FROM PUBLIC, merchant_app, merchant_ops, merchant_alert_receiver;
    GRANT EXECUTE ON FUNCTION public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb)
      TO merchant_alert_receiver;
  END IF;

  IF to_regprocedure('public.alert_webhook_receipts_ready()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.alert_webhook_receipts_ready()
      FROM PUBLIC, merchant_app, merchant_ops, merchant_alert_receiver;
    GRANT EXECUTE ON FUNCTION public.alert_webhook_receipts_ready()
      TO merchant_alert_receiver;
  END IF;
END
$$;

-- The global commercial catalog is a platform control-plane surface. Migration
-- 146 revokes every privilege on these six tables from `merchant_app`, but the
-- blanket `GRANT ... ON ALL TABLES IN SCHEMA public` near the top of this file
-- runs again *after* the migration chain and silently undid that REVOKE, so
-- the deny list was a no-op in every deployed environment. Pinning it here, at
-- the end of the script, matches migration 146's stated intent ("Merchant
-- runtime must consume a capability-trimmed application response; it never
-- receives direct access to global catalog base tables") and makes the final
-- state independent of any earlier `ALL TABLES` compatibility grant. Migration
-- 223 provides the replacement projection the runtime now reads.
--
-- Sequences: confirmed none of these six relations owns a sequence. All six are
-- keyed by caller-supplied TEXT ids with no DEFAULT, so
-- `GRANT USAGE, SELECT ON ALL SEQUENCES` has nothing to widen here and needs no
-- matching revoke. The loop still runs under the advisory lock taken at the top
-- of this file, so a concurrent bootstrap cannot interleave between the blanket
-- grant and this deny list.
DO $$
DECLARE
  relation_name TEXT;
BEGIN
  IF to_regclass('public.commercial_catalog_skus') IS NOT NULL THEN
    FOREACH relation_name IN ARRAY ARRAY[
      'commercial_catalog_skus', 'commercial_catalog_sku_versions',
      'commercial_catalog_sku_benefits', 'creative_point_rate_card_versions_v2',
      'creative_point_rate_rules_v2', 'commercial_catalog_events_v2'
    ] LOOP
      IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM merchant_app', relation_name);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- Migration 219 grants `merchant_app` SELECT on the shared platform rule tables
-- and reserves INSERT/UPDATE for `merchant_ops`. The blanket `GRANT ... ON ALL
-- TABLES` above re-widens them to full DML every time this bootstrap runs. That
-- escalates the tenant role across every merchant at once: these two tables have
-- no `workspace_id`, so there is no tenant boundary to fall back on, and the
-- audits table's append-only trigger rejects UPDATE/DELETE but not INSERT, so a
-- forged operations audit row is accepted. Deliberately narrower than the deny
-- list above: SELECT stays, because the tenant runtime reads public rules
-- through its own connection and migration 219 grants exactly that.
DO $$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'public_platform_rule_versions', 'public_platform_rule_audits'
  ] LOOP
    IF to_regclass(relation_name) IS NOT NULL THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %s FROM merchant_app', relation_name);
      EXECUTE format('GRANT SELECT ON TABLE %s TO merchant_app', relation_name);
    END IF;
  END LOOP;
END
$$;

COMMIT;
