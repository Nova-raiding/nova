-- 097_reconciliation_evidence_unknown_errors: preserve timeout/error context for fail-closed observations.
ALTER TABLE reconciliation_evidence
  DROP CONSTRAINT IF EXISTS reconciliation_evidence_failure_details;
ALTER TABLE reconciliation_evidence
  ADD CONSTRAINT reconciliation_evidence_failure_details CHECK (
    (provider_state IN ('failed','unknown') AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR (provider_state IN ('processing','succeeded') AND error_code IS NULL AND error_message IS NULL)
  );
