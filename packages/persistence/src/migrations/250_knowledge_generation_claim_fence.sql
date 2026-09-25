-- Durable product-scoped fence between generation provider attempts and
-- knowledge mutations. Unknown provider outcomes remain active until reconciled.
CREATE TABLE IF NOT EXISTS knowledge_generation_claims (
  claim_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  aggregate_id text NOT NULL,
  task_id text NOT NULL,
  logical_attempt integer NOT NULL CHECK (logical_attempt > 0),
  provider_attempt_id text NOT NULL,
  provider_attempt_key text NOT NULL,
  request_body_sha256 text NOT NULL,
  request_nonce text NOT NULL,
  product_id text NOT NULL,
  context_hash text NOT NULL,
  expected_documents jsonb NOT NULL CHECK (jsonb_typeof(expected_documents) = 'array' AND jsonb_array_length(expected_documents) <= 8),
  state text NOT NULL CHECK (state IN ('claimed','provider_started','outcome_unknown','completed','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CHECK ((state IN ('completed','rejected')) = (terminal_at IS NOT NULL)),
  UNIQUE (workspace_id, event_id, logical_attempt, provider_attempt_id)
);
CREATE INDEX IF NOT EXISTS knowledge_generation_claims_active_product_idx
  ON knowledge_generation_claims (workspace_id, product_id, created_at)
  WHERE state IN ('claimed','provider_started','outcome_unknown');
ALTER TABLE knowledge_generation_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_generation_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_generation_claims_workspace_isolation ON knowledge_generation_claims;
CREATE POLICY knowledge_generation_claims_workspace_isolation ON knowledge_generation_claims
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
    REVOKE ALL ON knowledge_generation_claims FROM merchant_app;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION knowledge_generation_assert_mutable(p_workspace_id text, p_product_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_product_id IS NULL THEN RETURN; END IF;
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'knowledge workspace scope mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id || ':' || p_product_id, 0));
  IF EXISTS (SELECT 1 FROM public.knowledge_generation_claims c
      WHERE c.workspace_id=p_workspace_id AND c.product_id=p_product_id
        AND c.state IN ('claimed','provider_started','outcome_unknown')) THEN
    RAISE EXCEPTION 'KNOWLEDGE_GENERATION_ACTIVE' USING ERRCODE='55000';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION knowledge_generation_lock_products(p_workspace_id text, p_product_ids text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p text;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'knowledge workspace scope mismatch' USING ERRCODE='42501';
  END IF;
  FOR p IN SELECT DISTINCT value FROM unnest(p_product_ids) value WHERE value IS NOT NULL ORDER BY value LOOP
    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id || ':' || p, 0));
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION knowledge_generation_guard_document_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE w text; p text;
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM public.knowledge_generation_lock_products(NEW.workspace_id,ARRAY[NEW.product_id]);
  ELSIF TG_OP='DELETE' THEN
    PERFORM public.knowledge_generation_lock_products(OLD.workspace_id,ARRAY[OLD.product_id]);
  ELSE
    PERFORM public.knowledge_generation_lock_products(OLD.workspace_id,ARRAY[OLD.product_id,NEW.product_id]);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.knowledge_generation_assert_mutable(OLD.workspace_id, OLD.product_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.knowledge_generation_assert_mutable(NEW.workspace_id, NEW.product_id);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS knowledge_generation_documents_guard ON knowledge_documents;
CREATE TRIGGER knowledge_generation_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION knowledge_generation_guard_document_mutation();

CREATE OR REPLACE FUNCTION knowledge_generation_guard_chunk_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE old_product text; new_product text; w text;
BEGIN
  IF TG_OP='INSERT' THEN w:=NEW.workspace_id;
  ELSE w:=OLD.workspace_id; END IF;
  IF TG_OP='UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'knowledge chunk workspace is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT product_id INTO old_product FROM public.knowledge_documents WHERE workspace_id=OLD.workspace_id AND id=OLD.document_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT product_id INTO new_product FROM public.knowledge_documents WHERE workspace_id=NEW.workspace_id AND id=NEW.document_id;
  END IF;
  PERFORM public.knowledge_generation_lock_products(w,ARRAY[old_product,new_product]);
  IF TG_OP <> 'INSERT' THEN PERFORM public.knowledge_generation_assert_mutable(OLD.workspace_id,old_product); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM public.knowledge_generation_assert_mutable(NEW.workspace_id,new_product); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS knowledge_generation_chunks_guard ON knowledge_chunks;
CREATE TRIGGER knowledge_generation_chunks_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION knowledge_generation_guard_chunk_mutation();

CREATE OR REPLACE FUNCTION knowledge_generation_guard_embedding_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE w text; old_product text; new_product text;
BEGIN
  IF TG_OP='INSERT' THEN w:=NEW.workspace_id;
  ELSE w:=OLD.workspace_id; END IF;
  IF TG_OP='UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'knowledge embedding workspace is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP <> 'INSERT' THEN SELECT product_id INTO old_product FROM public.knowledge_documents WHERE workspace_id=OLD.workspace_id AND id=OLD.document_id; END IF;
  IF TG_OP <> 'DELETE' THEN SELECT product_id INTO new_product FROM public.knowledge_documents WHERE workspace_id=NEW.workspace_id AND id=NEW.document_id; END IF;
  PERFORM public.knowledge_generation_lock_products(w,ARRAY[old_product,new_product]);
  IF TG_OP <> 'INSERT' THEN PERFORM public.knowledge_generation_assert_mutable(OLD.workspace_id,old_product); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM public.knowledge_generation_assert_mutable(NEW.workspace_id,new_product); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS knowledge_generation_embeddings_guard ON knowledge_embeddings;
CREATE TRIGGER knowledge_generation_embeddings_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_embeddings
  FOR EACH ROW EXECUTE FUNCTION knowledge_generation_guard_embedding_mutation();

CREATE OR REPLACE FUNCTION knowledge_generation_guard_asset_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE w text; a text; p text;
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM public.knowledge_generation_lock_products(NEW.workspace_id,
      COALESCE(ARRAY(SELECT product_id FROM public.knowledge_documents WHERE workspace_id=NEW.workspace_id AND knowledge_asset_id=NEW.id AND product_id IS NOT NULL UNION SELECT NEW.product_id WHERE NEW.product_id IS NOT NULL),ARRAY[]::text[]));
  ELSIF TG_OP='DELETE' THEN
    PERFORM public.knowledge_generation_lock_products(OLD.workspace_id,
      COALESCE(ARRAY(SELECT product_id FROM public.knowledge_documents WHERE workspace_id=OLD.workspace_id AND knowledge_asset_id=OLD.id AND product_id IS NOT NULL UNION SELECT OLD.product_id WHERE OLD.product_id IS NOT NULL),ARRAY[]::text[]));
  ELSE
    PERFORM public.knowledge_generation_lock_products(OLD.workspace_id,
      COALESCE(ARRAY(SELECT product_id FROM public.knowledge_documents WHERE workspace_id=OLD.workspace_id AND knowledge_asset_id=OLD.id AND product_id IS NOT NULL UNION SELECT OLD.product_id WHERE OLD.product_id IS NOT NULL UNION SELECT NEW.product_id WHERE NEW.product_id IS NOT NULL),ARRAY[]::text[]));
  END IF;
  IF TG_OP <> 'INSERT' THEN w:=OLD.workspace_id; a:=OLD.id;
    PERFORM public.knowledge_generation_assert_mutable(w,OLD.product_id);
    FOR p IN SELECT DISTINCT product_id FROM public.knowledge_documents WHERE workspace_id=w AND knowledge_asset_id=a AND product_id IS NOT NULL ORDER BY product_id LOOP
      PERFORM public.knowledge_generation_assert_mutable(w,p);
    END LOOP;
  END IF;
  IF TG_OP <> 'DELETE' THEN w:=NEW.workspace_id; a:=NEW.id;
    PERFORM public.knowledge_generation_assert_mutable(w,NEW.product_id);
    FOR p IN SELECT DISTINCT product_id FROM public.knowledge_documents WHERE workspace_id=w AND knowledge_asset_id=a AND product_id IS NOT NULL ORDER BY product_id LOOP
      PERFORM public.knowledge_generation_assert_mutable(w,p);
    END LOOP;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS knowledge_generation_assets_guard ON knowledge_assets;
CREATE TRIGGER knowledge_generation_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_assets
  FOR EACH ROW EXECUTE FUNCTION knowledge_generation_guard_asset_mutation();

CREATE OR REPLACE FUNCTION knowledge_generation_guard_binding_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='INSERT' THEN PERFORM public.knowledge_generation_lock_products(NEW.workspace_id,ARRAY[NEW.product_id]);
  ELSIF TG_OP='DELETE' THEN PERFORM public.knowledge_generation_lock_products(OLD.workspace_id,ARRAY[OLD.product_id]);
  ELSE PERFORM public.knowledge_generation_lock_products(OLD.workspace_id,ARRAY[OLD.product_id,NEW.product_id]); END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM public.knowledge_generation_assert_mutable(OLD.workspace_id,OLD.product_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM public.knowledge_generation_assert_mutable(NEW.workspace_id,NEW.product_id); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS knowledge_generation_bindings_guard ON knowledge_asset_bindings;
CREATE TRIGGER knowledge_generation_bindings_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_asset_bindings
  FOR EACH ROW EXECUTE FUNCTION knowledge_generation_guard_binding_mutation();

-- A claim also freezes the task's product/platform binding. These narrow
-- triggers share the document lock so a binding change cannot pass between a
-- successful claim and provider dispatch.
CREATE OR REPLACE FUNCTION knowledge_generation_guard_product_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.knowledge_generation_assert_mutable(OLD.workspace_id,OLD.id);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS knowledge_generation_product_binding_guard ON products;
CREATE TRIGGER knowledge_generation_product_binding_guard
  BEFORE UPDATE OF platform,platform_account_id,store_name OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION knowledge_generation_guard_product_binding();

CREATE OR REPLACE FUNCTION knowledge_generation_guard_task_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.knowledge_generation_lock_products(OLD.workspace_id,ARRAY[OLD.product_id]);
  ELSE
    PERFORM public.knowledge_generation_lock_products(OLD.workspace_id,ARRAY[OLD.product_id,NEW.product_id]);
  END IF;
  PERFORM public.knowledge_generation_assert_mutable(OLD.workspace_id,OLD.product_id);
  IF TG_OP='UPDATE' AND NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    PERFORM public.knowledge_generation_assert_mutable(NEW.workspace_id,NEW.product_id);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS knowledge_generation_task_binding_guard ON tasks;
CREATE TRIGGER knowledge_generation_task_binding_guard
  BEFORE UPDATE OF product_id,platform,platform_account_id,state OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION knowledge_generation_guard_task_binding();

CREATE OR REPLACE FUNCTION claim_knowledge_generation(
  p_workspace_id text, p_claim_id text, p_event_id text, p_aggregate_id text,
  p_task_id text, p_logical_attempt integer, p_provider_attempt_id text,
  p_provider_attempt_key text, p_request_body_sha256 text, p_request_nonce text,
  p_product_id text, p_context_hash text, p_expected_documents jsonb
) RETURNS TABLE(claim_id text, claim_state text, claimed_at timestamptz, refusal text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE existing public.knowledge_generation_claims%ROWTYPE; expected_count integer; selected_count integer; matched_count integer;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'knowledge workspace scope mismatch' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_expected_documents) <> 'array' OR jsonb_array_length(p_expected_documents)>8 THEN
    RAISE EXCEPTION 'KNOWLEDGE_EXPECTED_DOCUMENTS_REQUIRED' USING ERRCODE='22023';
  END IF;
  PERFORM public.knowledge_generation_lock_products(p_workspace_id,ARRAY[p_product_id]);
  SELECT * INTO existing FROM public.knowledge_generation_claims c
    WHERE c.workspace_id=p_workspace_id AND c.event_id=p_event_id
      AND c.logical_attempt=p_logical_attempt AND c.provider_attempt_id=p_provider_attempt_id;
  IF FOUND THEN
    IF existing.aggregate_id=p_aggregate_id AND existing.task_id=p_task_id
      AND existing.provider_attempt_key=p_provider_attempt_key
      AND existing.request_body_sha256=p_request_body_sha256 AND existing.request_nonce=p_request_nonce
      AND existing.product_id=p_product_id AND existing.context_hash=p_context_hash
      AND existing.expected_documents=p_expected_documents THEN
      RETURN QUERY SELECT existing.claim_id,existing.state,existing.created_at,NULL::text; RETURN;
    END IF;
    RETURN QUERY SELECT NULL::text,NULL::text,NULL::timestamptz,'attempt_conflict'::text; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.knowledge_generation_claims c WHERE c.workspace_id=p_workspace_id AND c.product_id=p_product_id AND c.state IN ('claimed','provider_started','outcome_unknown')) THEN
    RETURN QUERY SELECT NULL::text,NULL::text,NULL::timestamptz,'active_claim'::text; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.outbox_events e
      JOIN public.generation_jobs g ON g.workspace_id=e.workspace_id AND g.id=e.aggregate_id
      JOIN public.tasks t ON t.workspace_id=g.workspace_id AND t.id=g.task_id
      JOIN public.products p ON p.workspace_id=t.workspace_id AND p.id=t.product_id
      WHERE e.workspace_id=p_workspace_id AND e.id=p_event_id AND e.aggregate_id=p_aggregate_id
        AND e.event_type='generation.requested' AND e.payload->>'job_id'=p_aggregate_id
        AND e.payload->>'task_id'=p_task_id AND e.payload->>'context_hash'=p_context_hash
        AND e.payload->'input'->'product'->>'id'=p_product_id
        AND e.payload->'input'->>'platform'=t.platform
        AND g.task_id=p_task_id AND g.state IN ('queued','running')
        AND t.product_id=p_product_id AND t.platform=p.platform
        AND (t.platform_account_id IS NULL OR t.platform_account_id=p.platform_account_id)) THEN
    RETURN QUERY SELECT NULL::text,NULL::text,NULL::timestamptz,'snapshot_changed'::text; RETURN;
  END IF;
  expected_count:=jsonb_array_length(p_expected_documents);
  IF (SELECT count(DISTINCT value->>'document_id') FROM jsonb_array_elements(p_expected_documents) AS expected(value)) <> expected_count THEN
    RAISE EXCEPTION 'KNOWLEDGE_EXPECTED_DOCUMENTS_DUPLICATE' USING ERRCODE='22023';
  END IF;
  -- The API refuses a product with any live document still awaiting review or
  -- indexing, including documents that would not enter the top-eight search.
  IF EXISTS (SELECT 1 FROM public.knowledge_documents d
      WHERE d.workspace_id=p_workspace_id AND d.product_id=p_product_id
        AND d.index_state <> 'deleted'
        AND (d.index_state <> 'ready' OR d.approval_status <> 'approved' OR d.rights_status <> 'cleared')) THEN
    RETURN QUERY SELECT NULL::text,NULL::text,NULL::timestamptz,'snapshot_changed'::text; RETURN;
  END IF;
  -- Repository search first limits ready candidates by updated_at DESC,id,
  -- then ranks its zero-query results by id. Equal membership therefore
  -- implies equal prompt order for the same stable document identifiers.
  WITH selected AS (
    SELECT d.id,d.revision,d.extracted_text,d.expires_at
    FROM public.knowledge_documents d
    WHERE d.workspace_id=p_workspace_id AND d.product_id=p_product_id
      AND d.index_state='ready' AND d.approval_status='approved' AND d.rights_status='cleared'
    ORDER BY d.updated_at DESC,d.id LIMIT 8
  )
  SELECT count(*)::integer,
    count(*) FILTER (WHERE expected.value IS NOT NULL
      AND d.revision=(expected.value->>'revision')::integer
      AND encode(digest(COALESCE((SELECT string_agg(c.content,E'\n' ORDER BY c.ordinal)
          FROM public.knowledge_chunks c WHERE c.workspace_id=p_workspace_id AND c.document_id=d.id),d.extracted_text),'sha256'),'hex')=expected.value->>'content_sha256'
      AND (d.expires_at IS NULL OR d.expires_at>now()))::integer
    INTO selected_count,matched_count
  FROM selected d
  LEFT JOIN jsonb_array_elements(p_expected_documents) AS expected(value)
    ON expected.value->>'document_id'=d.id;
  IF selected_count <> expected_count OR matched_count <> expected_count THEN
    RETURN QUERY SELECT NULL::text,NULL::text,NULL::timestamptz,'snapshot_changed'::text; RETURN;
  END IF;
  INSERT INTO public.knowledge_generation_claims (claim_id,workspace_id,event_id,aggregate_id,task_id,
    logical_attempt,provider_attempt_id,provider_attempt_key,request_body_sha256,request_nonce,
    product_id,context_hash,expected_documents,state)
  VALUES (p_claim_id,p_workspace_id,p_event_id,p_aggregate_id,p_task_id,p_logical_attempt,
    p_provider_attempt_id,p_provider_attempt_key,p_request_body_sha256,p_request_nonce,
    p_product_id,p_context_hash,p_expected_documents,'claimed');
  RETURN QUERY SELECT p_claim_id,'claimed'::text,now(),NULL::text;
END $$;

CREATE OR REPLACE FUNCTION settle_knowledge_generation_claim(
  p_workspace_id text, p_claim_id text, p_provider_attempt_id text,
  p_provider_attempt_key text, p_request_body_sha256 text, p_request_nonce text,
  p_to_state text
) RETURNS TABLE(claim_state text, claimed_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.knowledge_generation_claims%ROWTYPE;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'knowledge workspace scope mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO c FROM public.knowledge_generation_claims WHERE workspace_id=p_workspace_id AND claim_id=p_claim_id FOR UPDATE;
  IF NOT FOUND OR c.provider_attempt_id<>p_provider_attempt_id OR c.provider_attempt_key<>p_provider_attempt_key
    OR c.request_body_sha256<>p_request_body_sha256 OR c.request_nonce<>p_request_nonce THEN
    RETURN;
  END IF;
  IF c.state=p_to_state THEN RETURN QUERY SELECT c.state,c.created_at,c.updated_at; RETURN; END IF;
  IF NOT ((c.state='claimed' AND p_to_state IN ('provider_started','rejected')) OR
    (c.state='provider_started' AND p_to_state IN ('outcome_unknown','completed','rejected'))) THEN RETURN; END IF;
  UPDATE public.knowledge_generation_claims SET state=p_to_state,updated_at=now(),
    terminal_at=CASE WHEN p_to_state IN ('completed','rejected') THEN now() ELSE NULL END
    WHERE workspace_id=p_workspace_id AND claim_id=p_claim_id RETURNING state,knowledge_generation_claims.created_at,knowledge_generation_claims.updated_at INTO claim_state,claimed_at,updated_at;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION claim_knowledge_generation(text,text,text,text,text,integer,text,text,text,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_knowledge_generation_claim(text,text,text,text,text,text,text) FROM PUBLIC;
-- Internal trigger helpers must not become standalone cross-tenant claim
-- probes or advisory-lock denial-of-service entry points.
REVOKE ALL ON FUNCTION public.knowledge_generation_assert_mutable(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_generation_lock_products(text,text[]) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION claim_knowledge_generation(text,text,text,text,text,integer,text,text,text,text,text,text,jsonb) TO merchant_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION settle_knowledge_generation_claim(text,text,text,text,text,text,text) TO merchant_app';
  END IF;
END $$;
