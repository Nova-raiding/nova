-- 192_allow_cent_test_orders: keep the database compatible with the
-- application-level, explicitly scoped one-fen payment probe. Ordinary
-- recharge requests remain protected by the API's one-yuan minimum.
ALTER TABLE billing_orders
  DROP CONSTRAINT IF EXISTS billing_orders_amount_fen_check;

ALTER TABLE billing_orders
  ADD CONSTRAINT billing_orders_amount_fen_check CHECK (amount_fen >= 1);
