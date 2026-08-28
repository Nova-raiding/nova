CREATE TABLE IF NOT EXISTS billing_orders (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  channel text NOT NULL CHECK (channel IN ('alipay','wechat')),
  amount_fen bigint NOT NULL CHECK (amount_fen >= 100),
  state text NOT NULL CHECK (state IN ('pending','paid','closed','failed')),
  payment_mode text NOT NULL CHECK (payment_mode IN ('fixture','provider')),
  payment_url text,
  provider_trade_id text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, provider_trade_id)
);
CREATE INDEX IF NOT EXISTS billing_orders_workspace_state_idx ON billing_orders(workspace_id,state,created_at DESC);
ALTER TABLE billing_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_orders_workspace_isolation ON billing_orders;
CREATE POLICY billing_orders_workspace_isolation ON billing_orders USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE IF NOT EXISTS billing_transactions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  type text NOT NULL CHECK (type IN ('recharge','debit','refund')),
  amount_fen bigint NOT NULL CHECK (amount_fen > 0),
  order_id text,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, order_id, type)
);
CREATE INDEX IF NOT EXISTS billing_transactions_workspace_created_idx ON billing_transactions(workspace_id,created_at DESC);
ALTER TABLE billing_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_transactions_workspace_isolation ON billing_transactions;
CREATE POLICY billing_transactions_workspace_isolation ON billing_transactions USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
