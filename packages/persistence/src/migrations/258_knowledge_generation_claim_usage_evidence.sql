-- Close an outcome-unknown knowledge claim only after the durable model usage
-- ledger proves that the exact provider attempt was settled.  Keep migration
-- 250's seven-argument function for already-deployed callers; this overload
-- is the forward-compatible path used by the current repository.
CREATE OR REPLACE FUNCTION settle_knowledge_generation_claim(
  p_workspace_id text, p_claim_id text, p_provider_attempt_id text,
  p_provider_attempt_key text, p_request_body_sha256 text, p_request_nonce text,
  p_to_state text, p_provider_request_id text
) RETURNS TABLE(claim_state text, claimed_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.knowledge_generation_claims%ROWTYPE; v_action_id text;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'knowledge workspace scope mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO c FROM public.knowledge_generation_claims
    WHERE workspace_id=p_workspace_id AND claim_id=p_claim_id FOR UPDATE;
  IF NOT FOUND OR c.provider_attempt_id<>p_provider_attempt_id
    OR c.provider_attempt_key<>p_provider_attempt_key
    OR c.request_body_sha256<>p_request_body_sha256
    OR c.request_nonce<>p_request_nonce THEN
    RETURN;
  END IF;
  IF c.state=p_to_state THEN
    RETURN QUERY SELECT c.state,c.created_at,c.updated_at;
    RETURN;
  END IF;
  IF c.state='outcome_unknown' AND p_to_state='completed' THEN
    SELECT NULLIF(btrim(e.payload->>'action_id'),'') INTO v_action_id
      FROM public.outbox_events e
      WHERE e.workspace_id=p_workspace_id AND e.id=c.event_id
        AND e.aggregate_id=c.aggregate_id AND e.event_type='generation.requested';
    -- A creative-point provider receipt is not sufficient to release the
    -- knowledge mutation fence.  Require the model usage ledger's settled,
    -- cost-bearing row and the exact physical provider-attempt metadata.
    IF v_action_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.model_usage_ledger m
      WHERE m.workspace_id=p_workspace_id
        AND m.action_id=v_action_id
        AND m.modality='text'
        AND m.settlement_status='settled'
        AND m.cost_cny IS NOT NULL
        -- Current text workers persist the physical idempotency key as
        -- provider_attempt_id, while the claim ledger also stores a
        -- deterministic provider_attempt_id UUID.  Accept either exact
        -- identity from the same claim; both are bound by the claim CAS
        -- fields above and cannot be supplied by an unrelated attempt.
        AND (m.metadata->>'provider_attempt_id'=c.provider_attempt_id
          OR m.metadata->>'provider_attempt_id'=c.provider_attempt_key)
        AND (p_provider_request_id IS NULL OR m.provider_request_id=p_provider_request_id)
    ) THEN
      RETURN;
    END IF;
  END IF;
  IF NOT ((c.state='claimed' AND p_to_state IN ('provider_started','rejected')) OR
    (c.state='provider_started' AND p_to_state IN ('outcome_unknown','completed','rejected')) OR
    (c.state='outcome_unknown' AND p_to_state='completed')) THEN
    RETURN;
  END IF;
  UPDATE public.knowledge_generation_claims SET state=p_to_state,updated_at=now(),
    terminal_at=CASE WHEN p_to_state IN ('completed','rejected') THEN now() ELSE NULL END
    WHERE workspace_id=p_workspace_id AND claim_id=p_claim_id
    RETURNING state,knowledge_generation_claims.created_at,knowledge_generation_claims.updated_at
      INTO claim_state,claimed_at,updated_at;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION settle_knowledge_generation_claim(text,text,text,text,text,text,text,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION settle_knowledge_generation_claim(text,text,text,text,text,text,text,text) TO merchant_app';
  END IF;
END $$;
