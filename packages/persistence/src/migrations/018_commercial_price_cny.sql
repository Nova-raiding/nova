DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspace_commercial_settings' AND column_name = 'monthly_price_fen') THEN
    ALTER TABLE workspace_commercial_settings RENAME COLUMN monthly_price_fen TO monthly_price_cny;
    ALTER TABLE workspace_commercial_settings RENAME COLUMN annual_price_fen TO annual_price_cny;
    ALTER TABLE workspace_commercial_settings ALTER COLUMN monthly_price_cny TYPE NUMERIC(12,2) USING monthly_price_cny / 100.0;
    ALTER TABLE workspace_commercial_settings ALTER COLUMN annual_price_cny TYPE NUMERIC(12,2) USING annual_price_cny / 100.0;
  END IF;
END $$;
