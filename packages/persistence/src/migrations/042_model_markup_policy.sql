CREATE TABLE IF NOT EXISTS model_markup_policy (
  singleton_key boolean PRIMARY KEY DEFAULT true CHECK (singleton_key),
  multiplier numeric(6,3) NOT NULL CHECK (multiplier >= 1 AND multiplier <= 10),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO model_markup_policy (singleton_key, multiplier, reason, updated_by)
VALUES (true, 2.500, '系统默认倍率', 'system')
ON CONFLICT (singleton_key) DO NOTHING;

ALTER TABLE model_usage_ledger
  ADD COLUMN IF NOT EXISTS markup_multiplier numeric(6,3) CHECK (markup_multiplier IS NULL OR (markup_multiplier >= 1 AND markup_multiplier <= 10)),
  ADD COLUMN IF NOT EXISTS customer_charge_cny numeric(12,6) CHECK (customer_charge_cny IS NULL OR customer_charge_cny >= 0),
  ADD COLUMN IF NOT EXISTS pricing_policy_revision integer CHECK (pricing_policy_revision IS NULL OR pricing_policy_revision > 0);
