DO $commercial_point_adjustment_approval_acl_repair$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_point_adjustment_proposals_v2, commercial_point_adjustment_decisions_v2 FROM merchant_ops;
    GRANT SELECT ON commercial_point_adjustment_proposals_v2, commercial_point_adjustment_decisions_v2 TO merchant_ops;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON commercial_point_adjustment_proposals_v2, commercial_point_adjustment_decisions_v2 TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON commercial_point_adjustment_proposals_v2, commercial_point_adjustment_decisions_v2 FROM merchant_app;
  END IF;
END
$commercial_point_adjustment_approval_acl_repair$;
