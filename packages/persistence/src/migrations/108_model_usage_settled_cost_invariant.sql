DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*)
    INTO invalid_count
    FROM model_usage_ledger
   WHERE settlement_status = 'settled'
     AND cost_cny IS NULL;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('migration 108 blocked: %s settled model usage row(s) have NULL cost_cny', invalid_count),
      HINT = 'Investigate and repair each historical receipt through an explicit audited process, or waive it explicitly; migration 108 never rewrites accounting data.';
  END IF;
END
$$;

ALTER TABLE model_usage_ledger
  ADD CONSTRAINT model_usage_settled_cost_required_check
  CHECK (settlement_status <> 'settled' OR cost_cny IS NOT NULL)
  NOT VALID;

ALTER TABLE model_usage_ledger
  VALIDATE CONSTRAINT model_usage_settled_cost_required_check;
