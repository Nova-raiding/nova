CREATE INDEX IF NOT EXISTS image_generation_execution_reconciliation_cursor_idx
  ON image_generation_executions (workspace_id, updated_at DESC, job_id ASC)
  WHERE state IN ('provider_started', 'outcome_unknown');
