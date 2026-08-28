-- Merchant-facing aliases remain metadata; the canonical store selector is
-- always (workspace_id, platform, account id).
ALTER TABLE platform_accounts
  ADD COLUMN IF NOT EXISTS store_alias text,
  ADD COLUMN IF NOT EXISTS authorization_revision integer NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS platform_accounts_store_alias_unique
  ON platform_accounts (workspace_id, platform, lower(store_alias))
  WHERE store_alias IS NOT NULL;
