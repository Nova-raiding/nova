-- 126_context_snapshot_canonical_scope_integrity: prevent a task context
-- snapshot from carrying a canonical/listing scope that disagrees with its
-- task. Legacy snapshots without canonical scope remain valid and readable.

CREATE OR REPLACE FUNCTION assert_context_snapshot_canonical_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  task_scope record;
  listing_scope record;
BEGIN
  IF (NEW.canonical_product_id IS NULL) <> (NEW.listing_id IS NULL) THEN
    RAISE EXCEPTION 'context snapshot canonical and listing scope must be provided together'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.canonical_product_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.brand_id IS NULL THEN
    RAISE EXCEPTION 'canonical context snapshot requires brand scope'
      USING ERRCODE = '23514';
  END IF;

  SELECT brand_id, canonical_product_id, listing_id
    INTO task_scope
    FROM public.tasks
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.task_id;
  IF NEW.task_id IS NOT NULL AND (NOT FOUND
      OR task_scope.brand_id IS DISTINCT FROM NEW.brand_id
      OR task_scope.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id
      OR task_scope.listing_id IS DISTINCT FROM NEW.listing_id) THEN
    RAISE EXCEPTION 'context snapshot task canonical scope mismatch: % / %'
      , NEW.workspace_id, NEW.task_id
      USING ERRCODE = '23514';
  END IF;

  SELECT brand_id, canonical_product_id
    INTO listing_scope
    FROM public.product_listings
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.listing_id;
  IF NOT FOUND
     OR listing_scope.brand_id IS DISTINCT FROM NEW.brand_id
     OR listing_scope.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id THEN
    RAISE EXCEPTION 'context snapshot listing canonical scope mismatch: % / %'
      , NEW.workspace_id, NEW.listing_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS context_snapshot_links_canonical_scope
  ON context_snapshot_links;
CREATE TRIGGER context_snapshot_links_canonical_scope
BEFORE INSERT OR UPDATE OF workspace_id, brand_id, task_id, canonical_product_id, listing_id
ON context_snapshot_links
FOR EACH ROW EXECUTE FUNCTION assert_context_snapshot_canonical_scope();

REVOKE ALL ON FUNCTION assert_context_snapshot_canonical_scope() FROM PUBLIC;
