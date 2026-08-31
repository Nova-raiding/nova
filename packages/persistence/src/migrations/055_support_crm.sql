CREATE TABLE IF NOT EXISTS workspace_support_tickets (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_number TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(btrim(subject)) BETWEEN 3 AND 200),
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 10000),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','waiting_customer','resolved','closed')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  customer_id TEXT NOT NULL CHECK (length(btrim(customer_id)) BETWEEN 1 AND 256),
  customer_name TEXT NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 200),
  customer_email TEXT CHECK (customer_email IS NULL OR length(customer_email) <= 320),
  assigned_to TEXT CHECK (assigned_to IS NULL OR length(btrim(assigned_to)) BETWEEN 1 AND 256),
  related_order_id TEXT CHECK (related_order_id IS NULL OR length(btrim(related_order_id)) BETWEEN 1 AND 256),
  related_task_id TEXT CHECK (related_task_id IS NULL OR length(btrim(related_task_id)) BETWEEN 1 AND 256),
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  create_idempotency_key TEXT NOT NULL CHECK (length(btrim(create_idempotency_key)) BETWEEN 8 AND 256),
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, ticket_number),
  UNIQUE (workspace_id, create_idempotency_key),
  CHECK (cardinality(tags) <= 20)
);

CREATE TABLE IF NOT EXISTS workspace_support_ticket_events (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('created','assigned','status_changed','commented')),
  actor_id TEXT NOT NULL CHECK (length(btrim(actor_id)) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 256),
  payload_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, ticket_id, sequence),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES workspace_support_tickets(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS workspace_support_tickets_page_idx
  ON workspace_support_tickets (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workspace_support_tickets_customer_idx
  ON workspace_support_tickets (workspace_id, customer_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workspace_support_tickets_queue_idx
  ON workspace_support_tickets (workspace_id, status, priority, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workspace_support_ticket_events_page_idx
  ON workspace_support_ticket_events (workspace_id, ticket_id, sequence ASC);

ALTER TABLE workspace_support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_support_tickets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_support_tickets_isolation ON workspace_support_tickets;
CREATE POLICY workspace_support_tickets_isolation ON workspace_support_tickets
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE workspace_support_ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_support_ticket_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_support_ticket_events_isolation ON workspace_support_ticket_events;
CREATE POLICY workspace_support_ticket_events_isolation ON workspace_support_ticket_events
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_support_ticket_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'support ticket events are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS workspace_support_ticket_events_immutable
  ON workspace_support_ticket_events;
CREATE TRIGGER workspace_support_ticket_events_immutable
BEFORE UPDATE OR DELETE ON workspace_support_ticket_events
FOR EACH ROW EXECUTE FUNCTION reject_support_ticket_event_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON workspace_support_ticket_events FROM PUBLIC;
