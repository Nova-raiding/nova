ALTER TABLE billing_orders
  ADD COLUMN IF NOT EXISTS created_by_actor_id text;

ALTER TABLE billing_transactions
  ADD COLUMN IF NOT EXISTS actor_id text;

ALTER TABLE workspace_subscription_orders
  ADD COLUMN IF NOT EXISTS created_by_actor_id text;

CREATE INDEX IF NOT EXISTS billing_orders_workspace_actor_created_idx
  ON billing_orders (workspace_id, created_by_actor_id, created_at DESC, id DESC)
  WHERE created_by_actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_transactions_workspace_actor_created_idx
  ON billing_transactions (workspace_id, actor_id, created_at DESC, id DESC)
  WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscription_orders_workspace_actor_created_idx
  ON workspace_subscription_orders (workspace_id, created_by_actor_id, created_at DESC, id DESC)
  WHERE created_by_actor_id IS NOT NULL;

COMMENT ON COLUMN billing_orders.created_by_actor_id IS
  'Authenticated workspace member that created the order. NULL means legacy/unattributed and must not be inferred.';
COMMENT ON COLUMN billing_transactions.actor_id IS
  'Authenticated member attributable to this ledger entry. NULL means system/legacy/unattributed.';
COMMENT ON COLUMN workspace_subscription_orders.created_by_actor_id IS
  'Authenticated workspace member that created the order. NULL means legacy/unattributed and must not be inferred.';
