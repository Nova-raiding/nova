ALTER TABLE commercial_catalog_sku_versions DROP CONSTRAINT commercial_catalog_sku_versions_lifecycle_check;
ALTER TABLE commercial_catalog_sku_versions ADD CONSTRAINT commercial_catalog_sku_versions_lifecycle_check CHECK(lifecycle IN ('draft','pending_business_approval','approved','rejected','retired'));
-- Append-only commercial facts remain unchanged; mutable sales state is a projection.
CREATE TABLE commercial_catalog_sales_v3 (
  sku_id text PRIMARY KEY REFERENCES commercial_catalog_skus(id),
  current_version_id text,
  state text NOT NULL CHECK(state IN ('unlisted','on_sale','off_sale','archived','deleted')),
  revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(current_version_id,sku_id) REFERENCES commercial_catalog_sku_versions(id,sku_id),
  CHECK ((state='on_sale')=(current_version_id IS NOT NULL))
);
-- Ambiguous or previously retired products remain blocked for explicit operator review.
INSERT INTO commercial_catalog_sales_v3(sku_id,current_version_id,state)
SELECT s.id,
  CASE WHEN latest.lifecycle<>'retired' AND eligible.count=1 THEN eligible.id ELSE NULL END,
  CASE WHEN latest.lifecycle='retired' THEN 'off_sale' WHEN eligible.count=1 THEN 'on_sale' ELSE 'unlisted' END
FROM commercial_catalog_skus s
LEFT JOIN LATERAL (SELECT lifecycle FROM commercial_catalog_sku_versions WHERE sku_id=s.id ORDER BY version DESC LIMIT 1) latest ON true
LEFT JOIN LATERAL (SELECT count(*) AS count,min(id) AS id FROM commercial_catalog_sku_versions WHERE sku_id=s.id AND lifecycle='approved' AND executable AND effective_at<=now()) eligible ON true;

CREATE TABLE commercial_catalog_mutations_v3 (
 actor_id text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,idempotency_key)
);
CREATE TRIGGER commercial_catalog_mutations_v3_immutable BEFORE UPDATE OR DELETE ON commercial_catalog_mutations_v3 FOR EACH ROW EXECUTE FUNCTION reject_commercial_catalog_fact_mutation();
CREATE TRIGGER commercial_catalog_mutations_v3_no_truncate BEFORE TRUNCATE ON commercial_catalog_mutations_v3 FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_catalog_fact_mutation();

CREATE TABLE commercial_benefit_bundles_v3 (
 id text PRIMARY KEY, code text NOT NULL UNIQUE, usage text NOT NULL CHECK(usage IN ('included','standalone')),
 revision integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','disabled','archived','deleted'))
);
CREATE TABLE commercial_benefit_bundle_versions_v3 (
 id text PRIMARY KEY, bundle_id text NOT NULL REFERENCES commercial_benefit_bundles_v3(id), version integer NOT NULL CHECK(version>0),
 name text NOT NULL, lifecycle text NOT NULL CHECK(lifecycle IN ('draft','pending_business_approval','approved','rejected')),
 benefits jsonb NOT NULL, payload jsonb NOT NULL, checksum text NOT NULL,
 actor_id text NOT NULL, reason text NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bundle_id,version), UNIQUE(id,bundle_id)
);
CREATE TABLE commercial_catalog_bundle_refs_v3 (
 sku_version_id text NOT NULL REFERENCES commercial_catalog_sku_versions(id),
 bundle_version_id text NOT NULL REFERENCES commercial_benefit_bundle_versions_v3(id),
 PRIMARY KEY(sku_version_id,bundle_version_id)
);
CREATE TABLE commercial_bundle_mutations_v3 (
 actor_id text NOT NULL,idempotency_key text NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,idempotency_key)
);
DO $immutable$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['commercial_benefit_bundle_versions_v3','commercial_catalog_bundle_refs_v3','commercial_bundle_mutations_v3'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_commercial_catalog_fact_mutation()',t||'_immutable',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_catalog_fact_mutation()',t||'_no_truncate',t);
 END LOOP;
END $immutable$;

CREATE FUNCTION merchant_resolve_sale_sku_v3(p_code text,p_include_private boolean DEFAULT false,p_capabilities text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sale public.commercial_catalog_sales_v3%ROWTYPE; result jsonb;
BEGIN
 IF nullif(current_setting('app.workspace_id',true),'') IS NULL THEN
   RAISE EXCEPTION 'workspace context required' USING ERRCODE='42501';
 END IF;
 SELECT sp.* INTO sale FROM public.commercial_catalog_sales_v3 sp JOIN public.commercial_catalog_skus s ON s.id=sp.sku_id
 WHERE s.code=p_code FOR SHARE OF sp;
 IF NOT FOUND OR sale.state<>'on_sale' THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('id',s.id,'code',s.code,'kind',s.kind,'visibility',s.visibility,'requiredCapability',s.required_capability,
 'versionId',v.id,'version',v.version,'lifecycle',v.lifecycle,'executable',v.executable,'priceFen',v.price_fen,'currency',v.currency,
 'priceMode',v.price_mode,'durationDays',v.duration_days,'payload',v.payload,'checksum',v.checksum,'effectiveAt',v.effective_at,
 'saleState',sale.state,'saleRevision',sale.revision,'currentSaleVersionId',sale.current_version_id,
 'benefits',COALESCE((SELECT jsonb_agg(jsonb_build_object('code',b.benefit_code,'quantity',b.quantity,'rawValue',b.raw_value,'rawUnit',b.raw_unit,'normalizedValue',b.normalized_value,'policyRef',b.policy_ref,'metadata',b.metadata) ORDER BY b.benefit_code) FROM public.commercial_catalog_sku_benefits b WHERE b.sku_version_id=v.id),'[]'::jsonb)) INTO result
 FROM public.commercial_catalog_skus s JOIN public.commercial_catalog_sku_versions v ON v.sku_id=s.id AND v.id=sale.current_version_id
 WHERE s.id=sale.sku_id AND v.lifecycle='approved' AND v.executable AND v.effective_at<=now()
 AND (s.visibility='public' OR (p_include_private AND (session_user='merchant_ops' OR current_setting('role',true)='merchant_ops') AND s.required_capability=ANY(p_capabilities)));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION merchant_resolve_sale_sku_v3(text,boolean,text[]) FROM PUBLIC;
REVOKE ALL ON commercial_catalog_sales_v3,commercial_catalog_mutations_v3,commercial_benefit_bundles_v3,commercial_benefit_bundle_versions_v3,commercial_catalog_bundle_refs_v3,commercial_bundle_mutations_v3 FROM PUBLIC;
DO $acl$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
 REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON commercial_catalog_skus,commercial_catalog_sku_versions,commercial_catalog_sku_benefits,commercial_catalog_events_v2 FROM merchant_ops;
 GRANT SELECT,INSERT ON commercial_catalog_skus,commercial_catalog_sku_versions,commercial_catalog_sku_benefits,commercial_catalog_events_v2 TO merchant_ops;
 GRANT SELECT,INSERT,UPDATE ON commercial_catalog_sales_v3,commercial_benefit_bundles_v3 TO merchant_ops;
 GRANT SELECT,INSERT ON commercial_catalog_mutations_v3,commercial_benefit_bundle_versions_v3,commercial_catalog_bundle_refs_v3,commercial_bundle_mutations_v3 TO merchant_ops;
 GRANT EXECUTE ON FUNCTION merchant_resolve_sale_sku_v3(text,boolean,text[]) TO merchant_ops;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
 REVOKE ALL ON commercial_catalog_skus,commercial_catalog_sku_versions,commercial_catalog_sku_benefits,commercial_catalog_events_v2 FROM merchant_app;
 REVOKE ALL ON commercial_catalog_sales_v3,commercial_catalog_mutations_v3,commercial_benefit_bundles_v3,commercial_benefit_bundle_versions_v3,commercial_catalog_bundle_refs_v3,commercial_bundle_mutations_v3 FROM merchant_app;
 GRANT EXECUTE ON FUNCTION merchant_resolve_sale_sku_v3(text,boolean,text[]) TO merchant_app;
 END IF;
END $acl$;
