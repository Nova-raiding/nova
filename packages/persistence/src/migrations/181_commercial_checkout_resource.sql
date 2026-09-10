-- 181_commercial_checkout_resource: persist a provider-owned checkout
-- resource separately from the immutable commercial order facts.
-- The URL is short-lived gateway output; it is never accepted from a client
-- and is cleared by the payment/refund state transition when appropriate.
ALTER TABLE commercial_orders_v2
  ADD COLUMN IF NOT EXISTS checkout_url TEXT,
  ADD COLUMN IF NOT EXISTS checkout_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS checkout_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS commercial_orders_v2_checkout_idempotency_idx
  ON commercial_orders_v2 (workspace_id, checkout_idempotency_key)
  WHERE checkout_idempotency_key IS NOT NULL;

ALTER TABLE commercial_orders_v2
  DROP CONSTRAINT IF EXISTS commercial_orders_v2_checkout_url_scheme;
ALTER TABLE commercial_orders_v2
  ADD CONSTRAINT commercial_orders_v2_checkout_url_scheme
  CHECK (checkout_url IS NULL OR checkout_url ~ '^(https://|weixin://|alipays://)');

DO $commercial_checkout_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, UPDATE ON commercial_orders_v2 TO merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON commercial_orders_v2 TO merchant_ops;
  END IF;
END
$commercial_checkout_acl$;
