CREATE TABLE IF NOT EXISTS commercial_offers (
  id text PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL,
  billing_cycle text NOT NULL CHECK (billing_cycle IN ('monthly','annual')),
  price_cny numeric(12,2) NOT NULL CHECK (price_cny >= 0), included_stores integer NOT NULL CHECK (included_stores >= 0), included_tasks integer NOT NULL CHECK (included_tasks >= 0), active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL, valid_to timestamptz, revision integer NOT NULL DEFAULT 1, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commercial_addons (
  id text PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, kind text NOT NULL CHECK (kind IN ('platform','image_generation','bulk_sync')), price_cny numeric(12,2) NOT NULL CHECK (price_cny >= 0), units integer NOT NULL CHECK (units >= 0), active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commercial_coupons (
  id text PRIMARY KEY, code text NOT NULL UNIQUE, discount_type text NOT NULL CHECK (discount_type IN ('fixed_cny','percent')), discount_value numeric(12,2) NOT NULL CHECK (discount_value >= 0), max_redemptions integer NOT NULL CHECK (max_redemptions >= 0), redeemed_count integer NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0), active boolean NOT NULL DEFAULT true, valid_from timestamptz NOT NULL, valid_to timestamptz, revision integer NOT NULL DEFAULT 1, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commercial_rollouts (
  id text PRIMARY KEY, offer_code text NOT NULL REFERENCES commercial_offers(code), workspace_id text NOT NULL DEFAULT '', percentage integer NOT NULL CHECK (percentage BETWEEN 0 AND 100), enabled boolean NOT NULL DEFAULT false, reason text NOT NULL, revision integer NOT NULL DEFAULT 1, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (offer_code, workspace_id)
);
CREATE TABLE IF NOT EXISTS workspace_subscription_changes (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), from_plan_code text NOT NULL, to_plan_code text NOT NULL, from_price_cny numeric(12,2) NOT NULL, to_price_cny numeric(12,2) NOT NULL, billing_cycle text NOT NULL CHECK (billing_cycle IN ('monthly','annual')), price_difference_cny numeric(12,2) NOT NULL, effective_at timestamptz NOT NULL, status text NOT NULL CHECK (status IN ('scheduled','applied','cancelled')), reason text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspace_subscription_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_subscription_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_subscription_changes_workspace_isolation ON workspace_subscription_changes;
CREATE POLICY workspace_subscription_changes_workspace_isolation ON workspace_subscription_changes USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
