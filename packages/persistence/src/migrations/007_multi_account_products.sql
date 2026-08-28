-- 007_multi_account_products: allow the same remote product id in multiple
-- stores on one platform while retaining tenant and store uniqueness.
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_workspace_platform_remote_key;
ALTER TABLE products
  ADD CONSTRAINT products_workspace_platform_account_remote_key
  UNIQUE (workspace_id, platform, platform_account_id, remote_product_id);
CREATE UNIQUE INDEX IF NOT EXISTS products_workspace_platform_remote_unbound_key
  ON products (workspace_id, platform, remote_product_id)
  WHERE platform_account_id IS NULL;
