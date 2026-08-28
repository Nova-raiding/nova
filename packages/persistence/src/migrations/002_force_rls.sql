-- 002_force_rls: prevent the application table owner from bypassing tenant RLS.
ALTER TABLE platform_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
