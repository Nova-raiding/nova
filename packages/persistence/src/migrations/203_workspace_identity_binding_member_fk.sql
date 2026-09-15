-- A durable identity binding must keep its matching workspace membership.
-- NOT VALID deliberately preserves visibility of historical orphan bindings
-- without silently granting membership during the migration. PostgreSQL still
-- enforces the constraint for all writes after it is installed.

ALTER TABLE workspace_identity_bindings
  ADD CONSTRAINT workspace_identity_bindings_member_fk
  FOREIGN KEY (workspace_id, external_subject)
  REFERENCES workspace_members (workspace_id, external_subject)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED
  NOT VALID;
