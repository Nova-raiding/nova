-- Platform feature flags are control-plane state. Tenant/runtime roles must
-- never mutate them directly; the API reaches them through a dedicated Ops
-- database role after application-layer RBAC succeeds.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE platform_feature_flags, platform_feature_flag_targets, platform_feature_flag_events FROM merchant_app;
  END IF;
END
$$;
