-- 148_harden_creative_point_reservations: forward-only hardening for the
-- immutable migration 144 ledger. Existing reservations may only be backfilled
-- from the exact rate-card version frozen in their original reserve intent.

ALTER TABLE creative_point_reservations
  ADD COLUMN rate_card_version TEXT;

UPDATE creative_point_reservations r
   SET rate_card_version = NULLIF(btrim(o.request->>'rate_card_version'), '')
  FROM creative_point_operations o
 WHERE o.workspace_id = r.workspace_id
   AND o.id = r.operation_id
   AND o.kind = 'reserve';

DO $creative_point_rate_card_backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM creative_point_reservations WHERE rate_card_version IS NULL) THEN
    RAISE EXCEPTION 'creative point reservation lacks authoritative rate-card evidence'
      USING ERRCODE = '23514';
  END IF;
END
$creative_point_rate_card_backfill$;

ALTER TABLE creative_point_reservations
  ALTER COLUMN rate_card_version SET NOT NULL,
  ADD CONSTRAINT creative_point_reservations_rate_card_version_check
    CHECK (btrim(rate_card_version) <> '');

CREATE OR REPLACE FUNCTION validate_creative_point_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  grant_capacity BIGINT;
  grant_allocated BIGINT;
  reservation_capacity BIGINT;
  reservation_allocated BIGINT;
BEGIN
  PERFORM 1 FROM creative_point_access_state
   WHERE workspace_id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'creative point access state is missing' USING ERRCODE = '23514';
  END IF;
  SELECT points INTO grant_capacity FROM creative_point_grants
   WHERE workspace_id=NEW.workspace_id AND id=NEW.grant_id;
  SELECT points INTO reservation_capacity FROM creative_point_reservations
   WHERE workspace_id=NEW.workspace_id AND id=NEW.reservation_id AND status='active';
  IF grant_capacity IS NULL OR reservation_capacity IS NULL THEN
    RAISE EXCEPTION 'creative point allocation target is not active' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(points_delta),0) INTO grant_allocated
    FROM creative_point_allocations
   WHERE workspace_id=NEW.workspace_id AND grant_id=NEW.grant_id;
  SELECT COALESCE(sum(points_delta),0) INTO reservation_allocated
    FROM creative_point_allocations
   WHERE workspace_id=NEW.workspace_id AND reservation_id=NEW.reservation_id;
  IF grant_allocated+NEW.points_delta < 0 OR grant_allocated+NEW.points_delta > grant_capacity THEN
    RAISE EXCEPTION 'creative point grant allocation is out of bounds' USING ERRCODE = '23514';
  END IF;
  IF reservation_allocated+NEW.points_delta < 0 THEN
    RAISE EXCEPTION 'creative point reservation allocation is out of bounds' USING ERRCODE = '23514';
  END IF;
  IF NEW.allocation_type='reserve' AND (NEW.points_delta < 1 OR reservation_allocated+NEW.points_delta > reservation_capacity) THEN
    RAISE EXCEPTION 'creative point reserve allocation is out of bounds' USING ERRCODE = '23514';
  END IF;
  IF NEW.allocation_type='release' AND NEW.points_delta > -1 THEN
    RAISE EXCEPTION 'creative point release allocation must reverse points' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER creative_point_allocations_validate
BEFORE INSERT ON creative_point_allocations
FOR EACH ROW EXECUTE FUNCTION validate_creative_point_allocation();
