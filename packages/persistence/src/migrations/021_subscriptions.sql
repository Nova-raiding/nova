CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','canceled')),
  plan_code TEXT NOT NULL DEFAULT 'trial', plan_name TEXT NOT NULL DEFAULT 'Trial',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','annual')),
  price_cny NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price_cny >= 0),
  included_stores INTEGER NOT NULL DEFAULT 1 CHECK (included_stores >= 0),
  included_tasks INTEGER NOT NULL DEFAULT 5 CHECK (included_tasks >= 0),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(), current_period_end TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 month',
  revision INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace_subscription_orders (
  id UUID PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL, plan_code TEXT NOT NULL, plan_name TEXT NOT NULL,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly','annual')),
  price_cny NUMERIC(12,2) NOT NULL CHECK (price_cny >= 0), included_stores INTEGER NOT NULL, included_tasks INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','closed','refunded')),
  payment_provider TEXT NOT NULL, provider_trade_id TEXT, idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ,
  UNIQUE (workspace_id, order_no), UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS workspace_subscription_orders_workspace_idx ON workspace_subscription_orders(workspace_id, created_at DESC);
ALTER TABLE workspace_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_subscription_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_subscription_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_subscriptions_isolation ON workspace_subscriptions USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_subscription_orders_isolation ON workspace_subscription_orders USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
