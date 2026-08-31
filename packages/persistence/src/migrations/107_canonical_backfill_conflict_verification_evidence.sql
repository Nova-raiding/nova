-- 107_canonical_backfill_conflict_verification_evidence: durable, structured
-- evidence for a bounded conflict recheck. Additive only; no business rows
-- are rewritten, resolved, or deleted.
ALTER TABLE canonical_backfill_conflicts
  ADD COLUMN IF NOT EXISTS verification_evidence JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(verification_evidence) = 'object');
