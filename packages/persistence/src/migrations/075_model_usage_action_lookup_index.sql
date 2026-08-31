-- Cost settlement scans every receipt for one action. Keep the full scan
-- semantics, but make the workspace/action lookup index-backed.
CREATE INDEX IF NOT EXISTS model_usage_ledger_workspace_action_observed_idx
  ON model_usage_ledger (workspace_id, action_id, observed_at DESC, id DESC)
  WHERE action_id IS NOT NULL;
