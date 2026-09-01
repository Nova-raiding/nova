-- Platform operators belong to the platform identity directory, never to a
-- merchant workspace membership. NOT VALID preserves historical rows for an
-- explicit audited migration while still rejecting every new/updated row.
ALTER TABLE workspace_members
  ADD CONSTRAINT workspace_members_no_platform_role
  CHECK (role <> 'platform_ops') NOT VALID;
