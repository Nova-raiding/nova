-- 012_nullable_remote_product_id: local/file-imported products may not have
-- a platform remote id until a later create/publish operation binds one.
ALTER TABLE products
  ALTER COLUMN remote_product_id DROP NOT NULL;
