-- Restored production databases may retain migration history while losing the
-- control-plane grants required to hydrate durable authorization context.
-- Repair only merchant_ops; merchant_app remains isolated.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    IF to_regclass('public.authorization_revisions') IS NOT NULL THEN
      GRANT SELECT, INSERT ON authorization_revisions TO merchant_ops;
      GRANT UPDATE (revision, updated_by, update_reason, updated_at) ON authorization_revisions TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON authorization_revisions FROM merchant_ops;
    END IF;
    IF to_regclass('public.platform_role_assignments') IS NOT NULL THEN
      GRANT SELECT, INSERT ON platform_role_assignments TO merchant_ops;
      GRANT UPDATE (revoked_at, revoked_by, revocation_reason, revision, authorization_revision, updated_at) ON platform_role_assignments TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON platform_role_assignments FROM merchant_ops;
    END IF;
    IF to_regclass('public.platform_role_assignment_events') IS NOT NULL THEN
      GRANT SELECT, INSERT ON platform_role_assignment_events TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON platform_role_assignment_events FROM merchant_ops;
    END IF;
    IF to_regclass('public.ops_access_grants') IS NOT NULL THEN
      GRANT SELECT, INSERT ON ops_access_grants TO merchant_ops;
      GRANT UPDATE (use_count, revoked_at, revoked_by, revocation_reason, revision, authorization_revision, updated_at) ON ops_access_grants TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON ops_access_grants FROM merchant_ops;
    END IF;
    IF to_regclass('public.ops_access_grant_events') IS NOT NULL THEN
      GRANT SELECT, INSERT ON ops_access_grant_events TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON ops_access_grant_events FROM merchant_ops;
    END IF;
  END IF;
END
$$;
