-- 121_authorization_execution_reservations_acl: converge legacy databases to
-- the least-privilege ACL declared by migration 120.
DO $authorization_execution_reservation_acl_convergence$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON authorization_execution_reservations FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT ON authorization_execution_reservations TO merchant_ops;
    REVOKE UPDATE, DELETE, TRUNCATE ON authorization_execution_reservations FROM merchant_ops;
  END IF;
END
$authorization_execution_reservation_acl_convergence$;
