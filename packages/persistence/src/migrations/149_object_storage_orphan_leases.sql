-- 149_object_storage_orphan_leases: persist cross-worker claims for orphan
-- cleanup. A lease is intentionally separate from the orphan lifecycle state:
-- pending rows may be claimed temporarily, while cleaned/manual_attention rows
-- remain terminal and are never eligible for a claim.

ALTER TABLE object_storage_orphans
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz;

CREATE INDEX IF NOT EXISTS object_storage_orphans_claim_idx
  ON object_storage_orphans (workspace_id, state, next_attempt_at, lease_until, created_at);
