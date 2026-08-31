-- 082_knowledge_hydration_revision_repair: repair databases created from
-- an earlier 079 definition that did not contain the CAS revision column.
-- The application must be able to hydrate against both fresh and upgraded DBs.

ALTER TABLE knowledge_hydration_snapshots
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_hydration_snapshots_revision_check'
      AND conrelid = 'knowledge_hydration_snapshots'::regclass
  ) THEN
    ALTER TABLE knowledge_hydration_snapshots
      ADD CONSTRAINT knowledge_hydration_snapshots_revision_check CHECK (revision >= 0);
  END IF;
END
$$;
