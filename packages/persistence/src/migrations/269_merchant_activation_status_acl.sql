-- Merchant activation changes an invited workspace member to active. Keep the
-- existing narrow Ops grant while allowing only that status transition.
DO $$
BEGIN
  IF to_regclass('public.workspace_members') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE UPDATE ON workspace_members FROM merchant_ops;
    GRANT UPDATE (status, identity_id, revision, updated_at) ON workspace_members TO merchant_ops;
  END IF;
END
$$;
