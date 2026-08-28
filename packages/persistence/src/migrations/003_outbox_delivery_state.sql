-- 003_outbox_delivery_state: durable dispatcher lease, retry and unknown state.
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error jsonb;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS unknown_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_events_dispatch_idx
  ON outbox_events (workspace_id, next_attempt_at, created_at, id)
  WHERE published_at IS NULL AND unknown_at IS NULL;
