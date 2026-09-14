-- Durable per-item evidence for customer delivery checklists.
CREATE TABLE IF NOT EXISTS workspace_customer_delivery_checklist_items (
  workspace_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  checklist_key TEXT NOT NULL CHECK (checklist_key IN ('system_integration','functional_acceptance')),
  item_key TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT false,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_by_actor_id TEXT,
  completed_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, delivery_id, checklist_key, item_key),
  FOREIGN KEY (workspace_id, delivery_id) REFERENCES workspace_customer_deliveries(workspace_id,id) ON DELETE RESTRICT
);
ALTER TABLE workspace_customer_delivery_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_customer_delivery_checklist_items FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY customer_delivery_checklist_workspace_isolation ON workspace_customer_delivery_checklist_items
    USING (workspace_id = current_setting('app.workspace_id', true))
    WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS customer_delivery_checklist_items_delivery_idx
  ON workspace_customer_delivery_checklist_items(workspace_id, delivery_id, checklist_key, item_key);

-- Videos are retained for audit/recovery; removal is a reversible soft delete.
ALTER TABLE workspace_customer_delivery_videos
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS customer_delivery_videos_active_idx
  ON workspace_customer_delivery_videos(workspace_id, delivery_id, sort_order, id)
  WHERE deleted_at IS NULL;
