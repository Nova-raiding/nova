-- Physical requests are fenced separately from migration 251's enqueue owner.
-- Unknown outcomes remain active until an audited reconciliation settles them.
CREATE TABLE charged_text_dispatch_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  action_key text NOT NULL,
  event_id text NOT NULL,
  logical_attempt integer NOT NULL CHECK (logical_attempt BETWEEN 1 AND 3),
  transport_attempt integer NOT NULL CHECK (transport_attempt BETWEEN 1 AND 3),
  provider_attempt_key text NOT NULL CHECK (provider_attempt_key ~ '^mm-[0-9a-f]{64}$'),
  request_body_sha256 text NOT NULL CHECK (request_body_sha256 ~ '^[0-9a-f]{64}$'),
  owner_token text NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed','provider_started','outcome_unknown','rejected','response_recorded','repair_required','completed')),
  provider_request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,action_key) REFERENCES creative_point_action_claims(workspace_id,action_key) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,event_id) REFERENCES outbox_events(workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (workspace_id,action_key,logical_attempt,transport_attempt),
  UNIQUE (workspace_id,provider_attempt_key,logical_attempt,transport_attempt)
);
CREATE UNIQUE INDEX charged_text_dispatch_one_active_action
  ON charged_text_dispatch_attempts(workspace_id,action_key)
  WHERE state IN ('claimed','provider_started','outcome_unknown','response_recorded');
ALTER TABLE charged_text_dispatch_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE charged_text_dispatch_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY charged_text_dispatch_workspace ON charged_text_dispatch_attempts
  USING (workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id=current_setting('app.workspace_id',true));
REVOKE ALL ON charged_text_dispatch_attempts FROM PUBLIC,merchant_app,merchant_ops;

CREATE FUNCTION claim_charged_text_dispatch_attempt(p_workspace text,p_action text,p_event text,
  p_logical integer,p_transport integer,p_attempt_key text,p_body_sha text)
RETURNS SETOF charged_text_dispatch_attempts LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE v_claim public.creative_point_action_claims%ROWTYPE; v_previous public.charged_text_dispatch_attempts%ROWTYPE;
BEGIN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'charged text dispatch workspace mismatch' USING ERRCODE='42501'; END IF;
  IF p_logical NOT BETWEEN 1 AND 3 OR p_transport NOT BETWEEN 1 AND 3
    OR p_attempt_key !~ '^mm-[0-9a-f]{64}$' OR p_body_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'charged text dispatch identity invalid' USING ERRCODE='22023'; END IF;
  -- Serialize every physical admission for the action, including two workers
  -- whose outbox leases overlapped after a network partition.
  SELECT * INTO v_claim FROM public.creative_point_action_claims
    WHERE workspace_id=p_workspace AND action_key=p_action AND event_id=p_event AND phase='bound' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM public.creative_point_reservations r
    JOIN public.generation_jobs j ON j.workspace_id=r.workspace_id AND j.id=v_claim.job_id
    JOIN public.outbox_events e ON e.workspace_id=j.workspace_id AND e.id=p_event
    WHERE r.workspace_id=p_workspace AND r.id=v_claim.reservation_id AND r.action_key=p_action AND r.status='active'
      AND j.state IN ('queued','running') AND e.event_type='generation.requested'
      AND e.aggregate_id=j.id AND e.unknown_at IS NULL
      AND v_claim.event_payload_sha256=encode(digest(e.payload::text,'sha256'),'hex')
    FOR SHARE OF r,j,e;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_previous FROM public.charged_text_dispatch_attempts
    WHERE workspace_id=p_workspace AND action_key=p_action
    ORDER BY logical_attempt DESC,transport_attempt DESC LIMIT 1;
  IF NOT FOUND THEN
    IF p_logical<>1 OR p_transport<>1 THEN RETURN; END IF;
  ELSIF v_previous.state='rejected' THEN
    IF p_logical<>v_previous.logical_attempt OR p_transport<>v_previous.transport_attempt+1
      OR p_attempt_key<>v_previous.provider_attempt_key OR p_body_sha<>v_previous.request_body_sha256 THEN RETURN; END IF;
  ELSIF v_previous.state='repair_required' THEN
    IF p_logical<>v_previous.logical_attempt+1 OR p_transport<>1 THEN RETURN; END IF;
  ELSE
    RETURN;
  END IF;
  RETURN QUERY INSERT INTO public.charged_text_dispatch_attempts
    (id,workspace_id,action_key,event_id,logical_attempt,transport_attempt,provider_attempt_key,request_body_sha256,owner_token,state)
    VALUES(gen_random_uuid()::text,p_workspace,p_action,p_event,p_logical,p_transport,p_attempt_key,p_body_sha,
      'charged_dispatch_'||gen_random_uuid()::text,'claimed')
    ON CONFLICT DO NOTHING RETURNING public.charged_text_dispatch_attempts.*;
END $$;

CREATE FUNCTION transition_charged_text_dispatch_attempt(p_workspace text,p_id text,p_owner text,
  p_to text,p_provider_request_id text DEFAULT NULL)
RETURNS SETOF charged_text_dispatch_attempts LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE v_attempt public.charged_text_dispatch_attempts%ROWTYPE;
BEGIN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'charged text dispatch workspace mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_attempt FROM public.charged_text_dispatch_attempts
    WHERE workspace_id=p_workspace AND id=p_id AND owner_token=p_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT ((v_attempt.state='claimed' AND p_to IN ('provider_started','rejected'))
    OR (v_attempt.state='provider_started' AND p_to IN ('outcome_unknown','rejected','response_recorded'))
    OR (v_attempt.state='response_recorded' AND p_to IN ('repair_required','completed','outcome_unknown'))) THEN RETURN; END IF;
  IF p_to IN ('response_recorded','repair_required','completed')
    AND coalesce(p_provider_request_id,v_attempt.provider_request_id,'')='' THEN RETURN; END IF;
  IF v_attempt.state='claimed' AND p_to='provider_started' THEN
    -- A release that won the race after claim but before physical dispatch
    -- invalidates admission. The reservation lock orders both transactions.
    PERFORM 1 FROM public.creative_point_action_claims c
      JOIN public.creative_point_reservations r ON r.workspace_id=c.workspace_id AND r.id=c.reservation_id
      JOIN public.generation_jobs j ON j.workspace_id=c.workspace_id AND j.id=c.job_id
      WHERE c.workspace_id=p_workspace AND c.action_key=v_attempt.action_key AND c.event_id=v_attempt.event_id
        AND c.phase='bound' AND r.status='active' AND j.state IN ('queued','running')
      FOR SHARE OF r,j;
    IF NOT FOUND THEN RETURN; END IF;
  END IF;
  RETURN QUERY UPDATE public.charged_text_dispatch_attempts SET state=p_to,
    provider_request_id=coalesce(p_provider_request_id,provider_request_id),updated_at=now()
    WHERE workspace_id=p_workspace AND id=p_id AND owner_token=p_owner AND state=v_attempt.state
    RETURNING public.charged_text_dispatch_attempts.*;
END $$;

CREATE FUNCTION guard_charged_text_dispatch_release()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.status='active' AND NEW.status='released' AND EXISTS (
    SELECT 1 FROM public.creative_point_action_claims c
    JOIN public.charged_text_dispatch_attempts a ON a.workspace_id=c.workspace_id AND a.action_key=c.action_key
    WHERE c.workspace_id=OLD.workspace_id AND c.reservation_id=OLD.id
      AND a.state IN ('provider_started','outcome_unknown','response_recorded','repair_required','completed')) THEN
    RAISE EXCEPTION 'charged text provider attempt requires settlement or reconciliation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER charged_text_dispatch_release_guard BEFORE UPDATE OF status ON creative_point_reservations
  FOR EACH ROW EXECUTE FUNCTION guard_charged_text_dispatch_release();
REVOKE ALL ON FUNCTION claim_charged_text_dispatch_attempt(text,text,text,integer,integer,text,text) FROM PUBLIC,merchant_app,merchant_ops;
REVOKE ALL ON FUNCTION transition_charged_text_dispatch_attempt(text,text,text,text,text) FROM PUBLIC,merchant_app,merchant_ops;
GRANT EXECUTE ON FUNCTION claim_charged_text_dispatch_attempt(text,text,text,integer,integer,text,text) TO merchant_app;
GRANT EXECUTE ON FUNCTION transition_charged_text_dispatch_attempt(text,text,text,text,text) TO merchant_app;
