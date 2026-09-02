-- 156_commercial_outbox_insert_acl: forward-only permission required for the
-- payment→grant→access-revision unit of work to append its tenant outbox fact.
-- UPDATE/DELETE/TRUNCATE remain denied and RLS continues to enforce workspace.
DO $commercial_outbox_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT INSERT ON outbox_events TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON outbox_events FROM merchant_app;
  END IF;
END
$commercial_outbox_acl$;
