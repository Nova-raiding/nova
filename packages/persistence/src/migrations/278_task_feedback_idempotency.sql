-- Durable replay protection for task feedback submissions.
ALTER TABLE task_feedback
  ADD COLUMN IF NOT EXISTS idempotency_key_hash text,
  ADD COLUMN IF NOT EXISTS request_hash text;

ALTER TABLE task_feedback
  DROP CONSTRAINT IF EXISTS task_feedback_idempotency_hashes_check;
ALTER TABLE task_feedback
  ADD CONSTRAINT task_feedback_idempotency_hashes_check
  CHECK ((idempotency_key_hash IS NULL AND request_hash IS NULL)
      OR (idempotency_key_hash IS NOT NULL AND request_hash IS NOT NULL
          AND idempotency_key_hash ~ '^[0-9a-f]{64}$'
          AND request_hash ~ '^[0-9a-f]{64}$'));

CREATE UNIQUE INDEX IF NOT EXISTS task_feedback_workspace_idempotency_key_idx
  ON task_feedback (workspace_id, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
