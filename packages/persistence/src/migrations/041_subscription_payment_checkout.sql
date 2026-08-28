-- Persist the payment channel and provider checkout URL for subscription
-- orders. Existing rows remain readable; new orders always write a concrete
-- channel instead of the historical pending_provider placeholder.
ALTER TABLE workspace_subscription_orders ADD COLUMN IF NOT EXISTS payment_url TEXT;
