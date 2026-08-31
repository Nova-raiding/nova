ALTER TABLE workspace_support_ticket_events
  DROP CONSTRAINT IF EXISTS workspace_support_ticket_events_event_type_check;

ALTER TABLE workspace_support_ticket_events
  ADD CONSTRAINT workspace_support_ticket_events_event_type_check
  CHECK (event_type IN ('created','assigned','status_changed','commented','sla_at_risk','sla_breached'));
