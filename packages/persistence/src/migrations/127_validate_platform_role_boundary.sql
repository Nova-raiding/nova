-- 127_validate_platform_role_boundary: complete the T8 migration gate.
-- Migration 124 rejected new platform_ops workspace memberships with a
-- NOT VALID constraint so historical rows could be inventoried and migrated
-- explicitly.  Do not rewrite business data here: validation must fail until
-- that audited backfill is complete, preventing a shadow/enforce mismatch.
ALTER TABLE workspace_members
  VALIDATE CONSTRAINT workspace_members_no_platform_role;
