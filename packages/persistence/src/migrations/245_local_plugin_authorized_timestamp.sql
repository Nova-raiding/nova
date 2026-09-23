-- Preserve migration 243's immutable checksum while repairing its authorization
-- state invariant for databases that already applied the earlier constraint.
ALTER TABLE local_plugin_connection_requests
  ADD CONSTRAINT local_plugin_connection_requests_authorized_timestamp_check
  CHECK (status <> 'authorized' OR authorized_at IS NOT NULL);
