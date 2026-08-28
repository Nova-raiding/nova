ALTER TABLE workspace_data_deletion_requests DROP CONSTRAINT IF EXISTS workspace_data_deletion_requests_status_check;
ALTER TABLE workspace_data_deletion_requests ADD CONSTRAINT workspace_data_deletion_requests_status_check CHECK (status IN ('pending','approved','cancelled','completed','incomplete'));
ALTER TABLE workspace_data_deletion_requests ADD COLUMN IF NOT EXISTS approvals JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(approvals) = 'array');
