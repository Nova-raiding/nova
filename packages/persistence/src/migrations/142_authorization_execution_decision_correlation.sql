-- 142_authorization_execution_decision_correlation: retain the authorization
-- decision that admitted each worker execution reservation for audit rebuilds.
ALTER TABLE authorization_execution_reservations
  ADD COLUMN IF NOT EXISTS decision_id TEXT;

UPDATE authorization_execution_reservations
SET decision_id = 'legacy-reservation:' || reservation_id
WHERE decision_id IS NULL;

ALTER TABLE authorization_execution_reservations
  ALTER COLUMN decision_id SET NOT NULL,
  ADD CONSTRAINT authorization_execution_reservations_decision_id_check
    CHECK (decision_id = btrim(decision_id) AND length(decision_id) BETWEEN 1 AND 255 AND decision_id !~ '[[:cntrl:]]');

CREATE INDEX IF NOT EXISTS authorization_execution_reservations_decision_idx
  ON authorization_execution_reservations (decision_id);
