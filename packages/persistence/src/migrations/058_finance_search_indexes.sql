-- Read-only finance search indexes. This migration deliberately adds no
-- projection tables: billing and usage ledgers remain the source of truth.
CREATE INDEX IF NOT EXISTS billing_orders_finance_search_idx
  ON billing_orders (workspace_id, created_at DESC, id DESC)
  INCLUDE (state, channel, amount_fen, updated_at);

CREATE INDEX IF NOT EXISTS billing_transactions_finance_search_idx
  ON billing_transactions (workspace_id, created_at DESC, id DESC)
  INCLUDE (type, amount_fen, order_id);

CREATE INDEX IF NOT EXISTS subscription_orders_finance_search_idx
  ON workspace_subscription_orders (workspace_id, created_at DESC, id DESC)
  INCLUDE (status, payment_provider, payment_amount_cny, plan_code, order_no, paid_at);

CREATE INDEX IF NOT EXISTS usage_ledger_finance_search_idx
  ON workspace_usage_ledger (workspace_id, created_at DESC, id DESC)
  INCLUDE (refunded, units, task_id, refunded_at);

CREATE INDEX IF NOT EXISTS model_usage_finance_search_idx
  ON model_usage_ledger (workspace_id, observed_at DESC, id DESC)
  INCLUDE (settlement_status, modality, model, cost_cny, customer_charge_cny, revision, resolved_at);
