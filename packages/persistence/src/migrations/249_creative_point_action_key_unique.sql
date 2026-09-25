-- A charged action may own exactly one hold for its entire lifetime.
-- Existing collisions are retained for investigation; migration fails closed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM creative_point_reservations
    GROUP BY workspace_id, action_key HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'CREATIVE_POINT_ACTION_KEY_DUPLICATES_REQUIRE_RECONCILIATION';
  END IF;
END $$;

CREATE UNIQUE INDEX creative_point_reservations_workspace_action_key_unique
  ON creative_point_reservations(workspace_id, action_key);
