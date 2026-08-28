ALTER TABLE workspace_subscription_orders ADD COLUMN IF NOT EXISTS payment_amount_cny NUMERIC(12,2);
UPDATE workspace_subscription_orders SET payment_amount_cny = price_cny WHERE payment_amount_cny IS NULL;
ALTER TABLE workspace_subscription_orders ALTER COLUMN payment_amount_cny SET DEFAULT 0;
ALTER TABLE workspace_subscription_orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;
ALTER TABLE workspace_subscription_orders ADD COLUMN IF NOT EXISTS addon_codes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workspace_subscription_orders ADD COLUMN IF NOT EXISTS source_channel TEXT;
