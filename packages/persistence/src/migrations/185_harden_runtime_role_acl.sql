-- 185_harden_runtime_role_acl: converge runtime-role ACLs after the local
-- compatibility bootstrap's broad table grant. Tenant runtime access must not
-- be able to mutate platform control-plane or immutable commercial facts.
--
-- This migration is intentionally forward-only and idempotent. It does not
-- rewrite business data or migration history.

DO $runtime_role_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    -- Platform control-plane state is served by the isolated Ops role.
    REVOKE ALL ON platform_feature_flags, platform_feature_flag_targets,
      platform_feature_flag_events, model_markup_policy
      FROM merchant_app;

    -- Media authoring is Ops-owned; merchant runtime receives only the active
    -- approved projection.
    REVOKE ALL ON platform_media_specs, platform_media_spec_audit,
      active_platform_media_specs FROM merchant_app;
    GRANT SELECT ON active_platform_media_specs TO merchant_app;

    -- Commercial catalog facts are global and read-only to merchant runtime.
    -- Keep SELECT for legacy/private-trial read paths; all mutation is denied.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE
      ON commercial_catalog_skus, commercial_catalog_sku_versions,
         commercial_catalog_sku_benefits, creative_point_rate_card_versions_v2,
         creative_point_rate_rules_v2, commercial_catalog_events_v2,
         commercial_offers, commercial_addons, commercial_coupons,
         commercial_rollouts
      FROM merchant_app;

    -- Migration history is not a runtime write surface. The API release
    -- endpoint may read the current version, but never mutate it.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM merchant_app;

    -- Audit facts are append-only and are not rewrite/delete surfaces.
    REVOKE UPDATE, DELETE, TRUNCATE
      ON knowledge_index_events, knowledge_deletion_proofs FROM merchant_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    -- Ops owns platform control-plane and commercial configuration.
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON platform_feature_flags, platform_feature_flag_targets TO merchant_ops;
    GRANT SELECT, INSERT ON platform_feature_flag_events TO merchant_ops;
    GRANT SELECT, INSERT, UPDATE ON model_markup_policy TO merchant_ops;

    GRANT SELECT, INSERT, UPDATE, DELETE
      ON commercial_offers, commercial_addons, commercial_coupons,
         commercial_rollouts, model_markup_policy TO merchant_ops;
    REVOKE TRUNCATE ON commercial_offers, commercial_addons,
      commercial_coupons, commercial_rollouts, model_markup_policy FROM merchant_ops;
  END IF;
END
$runtime_role_acl$;
