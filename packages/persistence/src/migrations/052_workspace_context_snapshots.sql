-- Generation context is an audit boundary for every task, including legacy
-- and newly imported products that have not yet been assigned to a brand.
ALTER TABLE context_snapshot_links
  ALTER COLUMN brand_id DROP NOT NULL;
