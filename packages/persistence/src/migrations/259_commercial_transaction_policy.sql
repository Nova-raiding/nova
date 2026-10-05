-- Contract v3 terms remain separate from immutable V2 snapshots. Existing
-- private-trial contracts retain their approved V2 policy; no silent repricing.
CREATE TABLE commercial_order_terms_v3 (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  order_id text NOT NULL,
  purchase_kind text NOT NULL CHECK (purchase_kind IN ('purchase','renewal','onboarding_once','point_pack','upgrade')),
  expires_at timestamptz NOT NULL,
  policy_version text NOT NULL,
  checkout_id text,
  onboarding_order_id text,
  upgrade_quote_id text,
  grant_status text NOT NULL DEFAULT 'pending' CHECK (grant_status IN ('pending','active','scheduled','awaiting_dependency','reconciliation_required','refunded')),
  granted_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,order_id),
  FOREIGN KEY(workspace_id,order_id) REFERENCES commercial_orders_v2(workspace_id,id),
  FOREIGN KEY(workspace_id,onboarding_order_id) REFERENCES commercial_orders_v2(workspace_id,id),
  CHECK(expires_at>created_at),
  CHECK((purchase_kind='upgrade')=(upgrade_quote_id IS NOT NULL))
);

CREATE TABLE workspace_commercial_onboarding_v3 (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  onboarding_order_id text,
  status text NOT NULL CHECK(status IN ('active','revoked','blocked')),
  activated_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  FOREIGN KEY(workspace_id,onboarding_order_id) REFERENCES commercial_orders_v2(workspace_id,id),
  CHECK(status<>'active' OR (onboarding_order_id IS NOT NULL AND activated_at IS NOT NULL))
);

-- Only an unambiguous verified onboarding source can become authority.
INSERT INTO workspace_commercial_onboarding_v3(workspace_id,onboarding_order_id,status,activated_at)
SELECT o.workspace_id,CASE WHEN count(*)=1 THEN min(o.id) ELSE NULL END,
       CASE WHEN count(*)=1 THEN 'active' ELSE 'blocked' END,
       CASE WHEN count(*)=1 THEN min(o.paid_at) ELSE NULL END
FROM commercial_orders_v2 o
JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id
WHERE o.status='paid' AND s.snapshot->'sku'->>'kind'='onboarding'
GROUP BY o.workspace_id;

CREATE TABLE commercial_upgrade_quotes_v3 (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  quote jsonb NOT NULL,
  target_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,idempotency_key),
  CHECK(expires_at>created_at)
);
ALTER TABLE commercial_order_terms_v3 ADD CONSTRAINT commercial_order_terms_v3_quote_fk
  FOREIGN KEY(workspace_id,upgrade_quote_id) REFERENCES commercial_upgrade_quotes_v3(workspace_id,id);
CREATE UNIQUE INDEX commercial_order_terms_v3_single_quote_order ON commercial_order_terms_v3(workspace_id,upgrade_quote_id) WHERE upgrade_quote_id IS NOT NULL;

CREATE TABLE commercial_upgrade_events_v3 (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  order_id text NOT NULL,
  quote_id text NOT NULL,
  period_id text NOT NULL,
  from_revision bigint NOT NULL,
  to_revision bigint NOT NULL,
  target_snapshot jsonb NOT NULL,
  quote jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,order_id),
  UNIQUE(workspace_id,period_id,to_revision),
  FOREIGN KEY(workspace_id,order_id) REFERENCES commercial_orders_v2(workspace_id,id),
  FOREIGN KEY(workspace_id,quote_id) REFERENCES commercial_upgrade_quotes_v3(workspace_id,id),
  FOREIGN KEY(workspace_id,period_id) REFERENCES workspace_subscription_periods_v2(workspace_id,id),
  CHECK(to_revision=from_revision+1)
);

CREATE TABLE commercial_point_grant_schedules_v3 (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  order_id text NOT NULL,
  period_id text,
  sequence integer NOT NULL CHECK(sequence>0),
  points bigint NOT NULL CHECK(points>0),
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('scheduled','granted','expired','canceled')),
  grant_id text,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,order_id,sequence),
  FOREIGN KEY(workspace_id,order_id) REFERENCES commercial_orders_v2(workspace_id,id),
  FOREIGN KEY(workspace_id,period_id) REFERENCES workspace_subscription_periods_v2(workspace_id,id),
  FOREIGN KEY(workspace_id,grant_id) REFERENCES creative_point_grants(workspace_id,id),
  CHECK(expires_at>due_at),
  CHECK(status<>'granted' OR grant_id IS NOT NULL)
);
CREATE INDEX commercial_point_grant_schedules_v3_due ON commercial_point_grant_schedules_v3(workspace_id,due_at,id) WHERE status='scheduled';

-- Approved immutable versions may configure a bounded grant schedule. Existing
-- source snapshots and quantities are left unchanged.
DO $schedule_constraints$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['onboarding_point_grant_schedules_v2','onboarding_point_grant_dispatches_v2','onboarding_point_grant_expirations_v2'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',t,t||'_sequence_check');
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',t,t||'_points_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(sequence BETWEEN 1 AND 24)',t,t||'_sequence_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(points BETWEEN 1 AND 9007199254740991)',t,t||'_points_check');
  END LOOP;
END $schedule_constraints$;
CREATE TABLE commercial_source_recovery_holds_v3 (
  workspace_id text NOT NULL REFERENCES workspaces(id),order_id text NOT NULL,request_id text NOT NULL,
  policy_version text NOT NULL,state text NOT NULL CHECK(state IN ('frozen','completed','released')),
  prior_period_status text,restored_period_id text,restored_revision bigint,restored_snapshot jsonb,restored_quote jsonb,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,request_id),FOREIGN KEY(workspace_id,order_id) REFERENCES commercial_orders_v2(workspace_id,id)
);
CREATE UNIQUE INDEX commercial_source_recovery_holds_v3_one_frozen ON commercial_source_recovery_holds_v3(workspace_id,order_id) WHERE state='frozen';

-- Historical revisions remain facts. A period's revision is its rebuildable
-- current pointer, so historic snapshots reference period identity, not the
-- one mutable current revision. Readers filter to the current revision.
ALTER TABLE workspace_entitlement_snapshots_v2 DROP CONSTRAINT workspace_entitlement_snapshots_v2_period_fk;
ALTER TABLE workspace_entitlement_snapshots_v2 ADD CONSTRAINT workspace_entitlement_snapshots_v2_period_fk
  FOREIGN KEY(workspace_id,subscription_period_id) REFERENCES workspace_subscription_periods_v2(workspace_id,id);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commercial_order_terms_v3','workspace_commercial_onboarding_v3','commercial_upgrade_quotes_v3','commercial_upgrade_events_v3','commercial_point_grant_schedules_v3','commercial_source_recovery_holds_v3'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON %I USING(workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true))',t||'_workspace_isolation',t);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO merchant_app',t);
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO merchant_ops',t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['commercial_upgrade_quotes_v3','commercial_upgrade_events_v3'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_commercial_contract_fact_mutation()',t||'_append_only',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_contract_fact_mutation()',t||'_no_truncate',t);
    EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM PUBLIC',t);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM merchant_app',t); END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM merchant_ops',t); END IF;
  END LOOP;
END
$rls$;

CREATE OR REPLACE FUNCTION public.merchant_entitlement_snapshots_v2(p_limit integer)
RETURNS TABLE (
  id text,
  workspace_id text,
  subscription_period_id text,
  period_start timestamptz,
  period_end timestamptz,
  period_status text,
  catalog_version_id text,
  sku_code text,
  resolved_benefits jsonb,
  unresolved_blockers jsonb,
  executable boolean,
  checksum text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
  SELECT
    e.id,
    e.workspace_id,
    e.subscription_period_id,
    p.period_start,
    p.period_end,
    p.status,
    e.catalog_version_id,
    s.code,
    e.resolved_benefits,
    e.unresolved_blockers,
    e.executable,
    e.checksum,
    e.created_at
  FROM public.workspace_entitlement_snapshots_v2 AS e
  JOIN public.workspace_subscription_periods_v2 AS p
    ON p.workspace_id = e.workspace_id AND p.id = e.subscription_period_id AND p.revision=e.subscription_period_revision
  JOIN public.commercial_catalog_sku_versions AS v ON v.id = e.catalog_version_id
  JOIN public.commercial_catalog_skus AS s ON s.id = v.sku_id
  WHERE e.workspace_id = current_setting('app.workspace_id', true)
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200)
$function$;


CREATE OR REPLACE FUNCTION public.merchant_entitlement_snapshots_v3(
  p_limit integer,
  p_after_created_at timestamptz DEFAULT NULL,
  p_after_id text DEFAULT NULL
)
RETURNS TABLE (
  id text,
  workspace_id text,
  subscription_period_id text,
  period_start timestamptz,
  period_end timestamptz,
  period_status text,
  catalog_version_id text,
  sku_code text,
  resolved_benefits jsonb,
  unresolved_blockers jsonb,
  executable boolean,
  checksum text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
  SELECT e.id, e.workspace_id, e.subscription_period_id, p.period_start, p.period_end,
         p.status, e.catalog_version_id, s.code, e.resolved_benefits,
         e.unresolved_blockers, e.executable, e.checksum, e.created_at
    FROM public.workspace_entitlement_snapshots_v2 AS e
    JOIN public.workspace_subscription_periods_v2 AS p
      ON p.workspace_id=e.workspace_id AND p.id=e.subscription_period_id AND p.revision=e.subscription_period_revision
    JOIN public.commercial_catalog_sku_versions AS v ON v.id=e.catalog_version_id
    JOIN public.commercial_catalog_skus AS s ON s.id=v.sku_id
   WHERE e.workspace_id=current_setting('app.workspace_id', true)
     AND (p_after_created_at IS NULL OR (e.created_at,e.id) < (p_after_created_at,p_after_id))
   ORDER BY e.created_at DESC,e.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 201)
$function$;

