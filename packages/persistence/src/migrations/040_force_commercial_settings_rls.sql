-- 040_force_commercial_settings_rls: make workspace commercial settings
-- policies effective even when the application role owns the tables.
ALTER TABLE workspace_commercial_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_platform_settings FORCE ROW LEVEL SECURITY;
