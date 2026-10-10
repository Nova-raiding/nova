-- A live lease can be copied into more than one queue delivery. Reserve each
-- lease for one handler invocation in PostgreSQL so workers on separate
-- processes cannot both execute the same outbox side effect.
ALTER TABLE outbox_events
  ADD COLUMN execution_owner text;
