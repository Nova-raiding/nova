-- Actual received cash is independent of an order or its fulfillment.
CREATE TABLE commercial_cash_receipts_v2 (
 id text PRIMARY KEY, workspace_id text REFERENCES workspaces(id),
 source text NOT NULL, receiving_account_ref text NOT NULL, external_trade_id text NOT NULL,
 payer_ref text NOT NULL, amount_fen bigint NOT NULL CHECK(amount_fen>0), currency text NOT NULL CHECK(currency='CNY'),
 received_at timestamptz NOT NULL, verified_at timestamptz NOT NULL, verified_by_actor_id text NOT NULL,
 evidence jsonb NOT NULL CHECK(evidence<>'{}'::jsonb), request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),
 UNIQUE(source,receiving_account_ref,external_trade_id), UNIQUE(workspace_id,id),
 CHECK(received_at<=verified_at), CHECK(length(trim(payer_ref))>0)
);
CREATE TABLE commercial_cash_receipt_balances_v2 (
 receipt_id text PRIMARY KEY REFERENCES commercial_cash_receipts_v2(id), workspace_id text REFERENCES workspaces(id),
 allocated_fen bigint NOT NULL DEFAULT 0 CHECK(allocated_fen>=0), returned_fen bigint NOT NULL DEFAULT 0 CHECK(returned_fen>=0),
 frozen_return_fen bigint NOT NULL DEFAULT 0 CHECK(frozen_return_fen>=0), revision bigint NOT NULL DEFAULT 1, UNIQUE(workspace_id,receipt_id)
);
CREATE TABLE commercial_cash_allocations_v2 (
 id text NOT NULL, workspace_id text NOT NULL REFERENCES workspaces(id), receipt_id text NOT NULL,
 order_id text NOT NULL, amount_fen bigint NOT NULL CHECK(amount_fen>0), idempotency_key text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'), actor_id text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,idempotency_key),
 FOREIGN KEY(workspace_id,receipt_id) REFERENCES commercial_cash_receipt_balances_v2(workspace_id,receipt_id),
 FOREIGN KEY(workspace_id,order_id) REFERENCES commercial_orders_v2(workspace_id,id)
);
CREATE TABLE commercial_cash_returns_v2 (
 id text PRIMARY KEY, workspace_id text REFERENCES workspaces(id), receipt_id text NOT NULL REFERENCES commercial_cash_receipts_v2(id),
 amount_fen bigint NOT NULL CHECK(amount_fen>0), payer_ref text NOT NULL, requested_by_actor_id text NOT NULL,
 approved_by_actor_id text, approval_evidence jsonb, reason text NOT NULL, evidence jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('requested','approved','pending_external','external_unknown','completed','rejected')),
 external_return_id text UNIQUE, request_hash text NOT NULL, created_at timestamptz NOT NULL, completed_at timestamptz,
 CHECK(approved_by_actor_id IS NULL OR approved_by_actor_id<>requested_by_actor_id),
 CHECK(status NOT IN ('approved','pending_external','external_unknown','completed') OR (approved_by_actor_id IS NOT NULL AND approval_evidence<>'{}'::jsonb)),
 CHECK(status<>'completed' OR (external_return_id IS NOT NULL AND completed_at IS NOT NULL))
);
-- Every write shares the same receipt lock; direct SQL writers cannot allocate or freeze twice.
CREATE FUNCTION enforce_commercial_cash_balance_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_amount bigint; actual_workspace text;
BEGIN
 SELECT amount_fen,workspace_id INTO receipt_amount,actual_workspace FROM commercial_cash_receipts_v2 WHERE id=NEW.receipt_id;
 IF receipt_amount IS NULL OR (actual_workspace IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM actual_workspace) OR
    NEW.allocated_fen+NEW.returned_fen+NEW.frozen_return_fen>receipt_amount THEN
   RAISE EXCEPTION 'cash receipt balance exceeds factual amount or scope' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commercial_cash_receipt_balance_bound BEFORE INSERT OR UPDATE ON commercial_cash_receipt_balances_v2 FOR EACH ROW EXECUTE FUNCTION enforce_commercial_cash_balance_v2();
DO $receipt_security$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['commercial_cash_receipts_v2','commercial_cash_receipt_balances_v2','commercial_cash_allocations_v2','commercial_cash_returns_v2'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
   EXECUTE format('CREATE POLICY %I ON %I USING (workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true))',table_name||'_workspace',table_name);
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
    EXECUTE format('GRANT SELECT,INSERT ON %I TO merchant_app',table_name);
   END IF;
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
    EXECUTE format('CREATE POLICY %I ON %I TO merchant_ops USING (current_setting(''app.platform_scope'',true)=''platform_ops'') WITH CHECK (current_setting(''app.platform_scope'',true)=''platform_ops'')',table_name||'_ops',table_name);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO merchant_ops',table_name);
   END IF;
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['commercial_cash_receipts_v2','commercial_cash_allocations_v2'] LOOP
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_commercial_contract_fact_mutation()',table_name||'_append_only',table_name);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_contract_fact_mutation()',table_name||'_no_truncate',table_name);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
  GRANT UPDATE ON commercial_cash_receipt_balances_v2,commercial_cash_returns_v2 TO merchant_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
  GRANT UPDATE ON commercial_cash_receipt_balances_v2,commercial_cash_returns_v2 TO merchant_ops;
 END IF;
END $receipt_security$;
CREATE INDEX commercial_cash_allocations_order_idx ON commercial_cash_allocations_v2(workspace_id,order_id,created_at,id);
CREATE INDEX commercial_cash_return_queue_idx ON commercial_cash_returns_v2(status,created_at,id);
-- Pending approved refunds freeze only grants derived from their source order.
CREATE TABLE commercial_refund_source_holds_v2 (
 workspace_id text NOT NULL REFERENCES workspaces(id),request_id text NOT NULL,order_id text NOT NULL,
 grant_id text NOT NULL,points bigint NOT NULL CHECK(points>0),created_at timestamptz NOT NULL,released_at timestamptz,
 PRIMARY KEY(workspace_id,request_id,grant_id),
 FOREIGN KEY(workspace_id,grant_id) REFERENCES creative_point_grants(workspace_id,id),
 FOREIGN KEY(workspace_id,order_id) REFERENCES commercial_orders_v2(workspace_id,id)
);
ALTER TABLE commercial_refund_source_holds_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_refund_source_holds_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_refund_source_holds_v2_workspace ON commercial_refund_source_holds_v2 USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN GRANT SELECT,INSERT,UPDATE ON commercial_refund_source_holds_v2 TO merchant_app; END IF;
END $$;

-- Unmatched receipts retain their immutable NULL workspace fact. Matching appends
-- evidence and assigns only the mutable balance projection to the verified tenant.
CREATE TABLE commercial_cash_receipt_matches_v2 (
 receipt_id text PRIMARY KEY REFERENCES commercial_cash_receipts_v2(id),workspace_id text NOT NULL REFERENCES workspaces(id),
 actor_id text NOT NULL, reason text NOT NULL,evidence jsonb NOT NULL CHECK(evidence<>'{}'::jsonb),created_at timestamptz NOT NULL
);
ALTER TABLE commercial_cash_receipt_matches_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_cash_receipt_matches_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_matches_workspace ON commercial_cash_receipt_matches_v2 USING(workspace_id=current_setting('app.workspace_id',true));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN GRANT SELECT ON commercial_cash_receipt_matches_v2 TO merchant_app; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
  CREATE POLICY cash_matches_ops ON commercial_cash_receipt_matches_v2 TO merchant_ops USING(current_setting('app.platform_scope',true)='platform_ops') WITH CHECK(current_setting('app.platform_scope',true)='platform_ops');
  GRANT SELECT,INSERT ON commercial_cash_receipt_matches_v2 TO merchant_ops;
 END IF;
END $$;
CREATE POLICY cash_receipt_matched_workspace ON commercial_cash_receipts_v2 USING(EXISTS(SELECT 1 FROM commercial_cash_receipt_matches_v2 m WHERE m.receipt_id=id AND m.workspace_id=current_setting('app.workspace_id',true)));
CREATE TRIGGER commercial_cash_receipt_matches_append_only BEFORE UPDATE OR DELETE ON commercial_cash_receipt_matches_v2 FOR EACH ROW EXECUTE FUNCTION reject_commercial_contract_fact_mutation();
CREATE TRIGGER commercial_cash_receipt_matches_no_truncate BEFORE TRUNCATE ON commercial_cash_receipt_matches_v2 FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_contract_fact_mutation();

CREATE FUNCTION enforce_commercial_cash_allocation_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cash_available bigint; order_amount bigint; already_allocated bigint; order_status text; cash_time timestamptz; deadline timestamptz;
BEGIN
 SELECT r.amount_fen-b.allocated_fen-b.returned_fen-b.frozen_return_fen,r.received_at INTO cash_available,cash_time
 FROM commercial_cash_receipt_balances_v2 b JOIN commercial_cash_receipts_v2 r ON r.id=b.receipt_id
 WHERE b.workspace_id=NEW.workspace_id AND b.receipt_id=NEW.receipt_id FOR UPDATE OF b;
 IF cash_available IS NULL OR cash_available<NEW.amount_fen THEN RAISE EXCEPTION 'cash receipt allocation exceeds available amount' USING ERRCODE='23514'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('workspace_subscription_periods_v2'),pg_catalog.hashtext(NEW.workspace_id));
 SELECT o.amount_fen,o.status,t.expires_at INTO order_amount,order_status,deadline FROM commercial_orders_v2 o
 LEFT JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id
 WHERE o.workspace_id=NEW.workspace_id AND o.id=NEW.order_id FOR UPDATE OF o;
 SELECT COALESCE(sum(amount_fen),0) INTO already_allocated FROM commercial_cash_allocations_v2 WHERE workspace_id=NEW.workspace_id AND order_id=NEW.order_id;
 IF order_status IS DISTINCT FROM 'pending' OR deadline IS NULL OR cash_time>=deadline OR already_allocated+NEW.amount_fen>order_amount THEN
  RAISE EXCEPTION 'order cannot accept cash allocation' USING ERRCODE='23514';
 END IF;
 UPDATE commercial_cash_receipt_balances_v2 SET allocated_fen=allocated_fen+NEW.amount_fen,revision=revision+1 WHERE workspace_id=NEW.workspace_id AND receipt_id=NEW.receipt_id;
 RETURN NEW;
END $$;
CREATE TRIGGER commercial_cash_allocation_balance BEFORE INSERT ON commercial_cash_allocations_v2 FOR EACH ROW EXECUTE FUNCTION enforce_commercial_cash_allocation_v2();

-- Package receipt -> atomic contract fulfillment -> source refund SQL closure.
-- Operations callers use the same workspace-scoped transaction and FORCE RLS
-- as tenant runtime callers. Granting row locks is not a global tenant bypass.
DO $package_commercial_runtime_acl$
DECLARE runtime_role text; relation_name text;
BEGIN
 FOREACH runtime_role IN ARRAY ARRAY['merchant_app','merchant_ops'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN CONTINUE; END IF;
  FOREACH relation_name IN ARRAY ARRAY[
   'commercial_orders_v2','workspace_subscription_periods_v2',
   'commercial_order_terms_v3','workspace_commercial_onboarding_v3',
   'commercial_point_grant_schedules_v3','commercial_source_recovery_holds_v3',
   'onboarding_point_grant_schedules_v2','creative_point_access_state',
   'creative_point_operations','creative_point_reservations',
   'commercial_cash_receipt_balances_v2','commercial_cash_returns_v2',
   'commercial_refund_source_holds_v2'
  ] LOOP
   IF to_regclass(format('public.%I',relation_name)) IS NOT NULL THEN
    EXECUTE format('REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.%I FROM %I',relation_name,runtime_role);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.%I TO %I',relation_name,runtime_role);
   END IF;
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY[
   'commercial_order_snapshots_v2','workspace_entitlement_snapshots_v2',
   'commercial_payment_events_v2','commercial_upgrade_quotes_v3','commercial_upgrade_events_v3',
   'creative_point_grants','creative_point_allocations','creative_point_ledger_events',
   'creative_point_adjustments_v2','commercial_refund_events_v2','commercial_access_decisions_v2',
   'onboarding_point_grant_dispatches_v2','onboarding_point_grant_expirations_v2',
   'commercial_cash_receipts_v2','commercial_cash_allocations_v2'
  ] LOOP
   IF to_regclass(format('public.%I',relation_name)) IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.%I FROM %I',relation_name,runtime_role);
    EXECUTE format('GRANT SELECT,INSERT ON TABLE public.%I TO %I',relation_name,runtime_role);
   END IF;
  END LOOP;
  -- PostgreSQL SELECT ... FOR UPDATE OF g needs UPDATE on one column. Source
  -- grants remain immutable: the existing row and statement triggers reject
  -- every actual UPDATE/DELETE/TRUNCATE; no other grant column is writable.
  IF to_regclass('public.creative_point_grants') IS NOT NULL THEN
   EXECUTE format('GRANT UPDATE(id) ON TABLE public.creative_point_grants TO %I',runtime_role);
  END IF;
  IF to_regclass('public.outbox_events') IS NOT NULL THEN
   EXECUTE format('GRANT SELECT,INSERT ON TABLE public.outbox_events TO %I',runtime_role);
  END IF;
 END LOOP;
 IF to_regclass('public.commercial_cash_receipt_matches_v2') IS NOT NULL THEN
  REVOKE ALL ON commercial_cash_receipt_matches_v2 FROM merchant_app,merchant_ops;
  GRANT SELECT ON commercial_cash_receipt_matches_v2 TO merchant_app;
  GRANT SELECT,INSERT ON commercial_cash_receipt_matches_v2 TO merchant_ops;
 END IF;
END $package_commercial_runtime_acl$;

-- Restore migration 154's controlled Ops service consumer. API still requires
-- service write capability and the customer's immutable boundary acceptance.
DO $commercial_service_runtime_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') AND to_regclass('public.workspace_service_allocations') IS NOT NULL THEN
  REVOKE ALL ON workspace_service_allocations,workspace_service_fulfillment_events FROM merchant_app;
  REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON workspace_service_allocations,workspace_service_fulfillment_events FROM merchant_ops;
  GRANT SELECT,INSERT ON workspace_service_allocations,workspace_service_fulfillment_events TO merchant_ops;
  GRANT UPDATE(revision,status,used_quantity,updated_at) ON workspace_service_allocations TO merchant_ops;
 END IF;
END $commercial_service_runtime_acl$;

-- Source recovery evaluates current tenant brands, live stores and actual
-- storage usage. Preserve approved read surfaces; add only missing columns.
-- The quota row lock needs UPDATE privilege on one non-consumption column.
DO $commercial_source_usage_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
  IF to_regclass('public.brands') IS NOT NULL THEN
   GRANT SELECT(workspace_id) ON brands TO merchant_ops;
  END IF;
  IF to_regclass('public.platform_accounts') IS NOT NULL THEN
   GRANT SELECT(workspace_id,token_state) ON platform_accounts TO merchant_ops;
  END IF;
  IF to_regclass('public.brand_store_bindings') IS NOT NULL THEN
   GRANT SELECT(workspace_id,platform,platform_account_id,status) ON brand_store_bindings TO merchant_ops;
  END IF;
  IF to_regclass('public.workspace_storage_quotas') IS NOT NULL THEN
   GRANT SELECT(workspace_id,used_bytes,reserved_bytes) ON workspace_storage_quotas TO merchant_ops;
   GRANT UPDATE(limit_bytes) ON workspace_storage_quotas TO merchant_ops;
  END IF;
 END IF;
END $commercial_source_usage_acl$;
