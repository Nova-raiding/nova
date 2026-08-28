CREATE TABLE IF NOT EXISTS workspace_commercial_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL DEFAULT 'starter', plan_name TEXT NOT NULL DEFAULT 'Starter',
  monthly_price_cny NUMERIC(12,2) NOT NULL DEFAULT 199.00 CHECK (monthly_price_cny >= 0),
  annual_price_cny NUMERIC(12,2) NOT NULL DEFAULT 1990.00 CHECK (annual_price_cny >= 0),
  included_stores INTEGER NOT NULL DEFAULT 1 CHECK (included_stores >= 0),
  included_tasks INTEGER NOT NULL DEFAULT 30 CHECK (included_tasks >= 0),
  revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL DEFAULT 'system', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace_platform_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')),
  enabled BOOLEAN NOT NULL DEFAULT true, display_name TEXT NOT NULL DEFAULT '', store_alias TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL DEFAULT 'system', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform)
);
ALTER TABLE workspace_commercial_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_commercial_settings_isolation ON workspace_commercial_settings USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_platform_settings_isolation ON workspace_platform_settings USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
