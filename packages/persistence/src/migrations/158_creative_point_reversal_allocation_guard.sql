-- 158_creative_point_reversal_allocation_guard: forward-only extension of the
-- allocation trigger for append-only reversals and approved negative Ops
-- adjustments. Historical allocations remain immutable.
CREATE OR REPLACE FUNCTION validate_creative_point_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  grant_capacity BIGINT;
  grant_allocated BIGINT;
  reservation_capacity BIGINT;
  reservation_allocated BIGINT;
  reservation_status TEXT;
BEGIN
  PERFORM 1 FROM creative_point_access_state
   WHERE workspace_id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'creative point access state is missing' USING ERRCODE = '23514';
  END IF;
  SELECT points, status INTO reservation_capacity, reservation_status
    FROM creative_point_reservations
   WHERE workspace_id=NEW.workspace_id AND id=NEW.reservation_id;
  SELECT points INTO grant_capacity FROM creative_point_grants
   WHERE workspace_id=NEW.workspace_id AND id=NEW.grant_id;
  IF grant_capacity IS NULL OR reservation_capacity IS NULL THEN
    RAISE EXCEPTION 'creative point allocation target is missing' USING ERRCODE = '23514';
  END IF;
  IF NEW.allocation_type IN ('reserve','release','settle_adjustment') AND reservation_status <> 'active' THEN
    RAISE EXCEPTION 'creative point allocation target is not active' USING ERRCODE = '23514';
  END IF;
  IF NEW.allocation_type IN ('reverse','adjustment') AND reservation_status <> 'settled' THEN
    RAISE EXCEPTION 'creative point reversal target is not settled' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(points_delta),0) INTO grant_allocated
    FROM creative_point_allocations WHERE workspace_id=NEW.workspace_id AND grant_id=NEW.grant_id;
  SELECT COALESCE(sum(points_delta),0) INTO reservation_allocated
    FROM creative_point_allocations WHERE workspace_id=NEW.workspace_id AND reservation_id=NEW.reservation_id;
  IF grant_allocated+NEW.points_delta < 0 OR grant_allocated+NEW.points_delta > grant_capacity THEN
    RAISE EXCEPTION 'creative point grant allocation is out of bounds' USING ERRCODE = '23514';
  END IF;
  IF reservation_allocated+NEW.points_delta < 0 OR reservation_allocated+NEW.points_delta > reservation_capacity THEN
    RAISE EXCEPTION 'creative point reservation allocation is out of bounds' USING ERRCODE = '23514';
  END IF;
  IF NEW.allocation_type IN ('reserve','adjustment') AND NEW.points_delta < 1 THEN
    RAISE EXCEPTION 'creative point allocation must consume points' USING ERRCODE = '23514';
  END IF;
  IF NEW.allocation_type IN ('release','reverse') AND NEW.points_delta > -1 THEN
    RAISE EXCEPTION 'creative point allocation must reverse points' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
