-- The first charged text enqueue has one durable action owner. This table does
-- not describe physical provider attempts or decide whether a retry is safe.
CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_workspace_id_action_claim_fk ON outbox_events(workspace_id,id);
CREATE TABLE creative_point_action_claims (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  action_key text NOT NULL CHECK (length(action_key) BETWEEN 1 AND 255),
  intent_sha256 text NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  phase text NOT NULL CHECK (phase IN ('available','leased','bound')),
  owner_epoch bigint NOT NULL CHECK (owner_epoch > 0),
  owner_token text,
  lease_until timestamptz,
  reservation_id text,
  job_id text,
  event_id text,
  event_payload_sha256 text CHECK (event_payload_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,action_key),
  FOREIGN KEY (workspace_id,reservation_id) REFERENCES creative_point_reservations(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,job_id) REFERENCES generation_jobs(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,event_id) REFERENCES outbox_events(workspace_id,id) ON DELETE RESTRICT,
  CHECK ((phase='leased' AND owner_token IS NOT NULL AND lease_until IS NOT NULL AND reservation_id IS NULL AND job_id IS NULL AND event_id IS NULL AND event_payload_sha256 IS NULL)
    OR (phase='available' AND owner_token IS NULL AND lease_until IS NULL AND reservation_id IS NULL AND job_id IS NULL AND event_id IS NULL AND event_payload_sha256 IS NULL)
    OR (phase='bound' AND owner_token IS NULL AND lease_until IS NULL AND reservation_id IS NOT NULL AND job_id IS NOT NULL AND event_id IS NOT NULL AND event_payload_sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX creative_action_reservation_unique ON creative_point_action_claims(workspace_id,reservation_id) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX creative_action_job_unique ON creative_point_action_claims(workspace_id,job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX creative_action_event_unique ON creative_point_action_claims(workspace_id,event_id) WHERE event_id IS NOT NULL;
ALTER TABLE creative_point_action_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_point_action_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_point_action_claims_tenant ON creative_point_action_claims
  USING (workspace_id=current_setting('app.workspace_id',true)) WITH CHECK (workspace_id=current_setting('app.workspace_id',true));
REVOKE ALL ON creative_point_action_claims FROM PUBLIC,merchant_app,merchant_ops;
GRANT SELECT ON creative_point_action_claims TO merchant_app;

CREATE FUNCTION claim_creative_point_action(p_workspace text,p_action text,p_intent text,p_lease_ms bigint)
RETURNS SETOF creative_point_action_claims LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_token text;
BEGIN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'creative action tenant mismatch' USING ERRCODE='42501'; END IF;
  IF p_action IS NULL OR length(p_action) NOT BETWEEN 1 AND 255 OR p_intent !~ '^[0-9a-f]{64}$' OR p_lease_ms NOT BETWEEN 1 AND 86400000 THEN
    RAISE EXCEPTION 'creative action claim input invalid' USING ERRCODE='22023'; END IF;
  v_token := 'creative_action_'||gen_random_uuid()::text;
  RETURN QUERY INSERT INTO public.creative_point_action_claims(workspace_id,action_key,intent_sha256,phase,owner_epoch,owner_token,lease_until)
    VALUES(p_workspace,p_action,p_intent,'leased',1,v_token,now()+p_lease_ms*interval '1 millisecond')
    ON CONFLICT(workspace_id,action_key) DO UPDATE SET phase='leased',owner_epoch=public.creative_point_action_claims.owner_epoch+1,
      owner_token=EXCLUDED.owner_token,lease_until=EXCLUDED.lease_until,updated_at=now()
    WHERE public.creative_point_action_claims.intent_sha256=EXCLUDED.intent_sha256
      AND (public.creative_point_action_claims.phase='available' OR
        (public.creative_point_action_claims.phase='leased' AND public.creative_point_action_claims.lease_until<=now()))
    RETURNING public.creative_point_action_claims.*;
END $$;

-- Call inside the same workspace transaction that saves generation_job and
-- appends generation.requested. If any identity check fails all three roll back.
CREATE FUNCTION bind_creative_point_action(p_workspace text,p_action text,p_token text,p_epoch bigint,
  p_reservation text,p_job text,p_event text)
RETURNS SETOF creative_point_action_claims LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_intent text; v_payload_sha text;
BEGIN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'creative action tenant mismatch' USING ERRCODE='42501'; END IF;
  SELECT intent_sha256 INTO v_intent FROM public.creative_point_action_claims
    WHERE workspace_id=p_workspace AND action_key=p_action AND owner_token=p_token AND owner_epoch=p_epoch
      AND phase='leased' AND lease_until>now() FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT encode(digest(e.payload::text,'sha256'),'hex') INTO v_payload_sha
  FROM public.creative_point_reservations r
  JOIN public.creative_point_operations o ON o.workspace_id=r.workspace_id AND o.id=r.operation_id
  JOIN public.generation_jobs j ON j.workspace_id=r.workspace_id
  JOIN public.tasks t ON t.workspace_id=j.workspace_id AND t.id=j.task_id
  JOIN public.outbox_events e ON e.workspace_id=j.workspace_id
  WHERE r.workspace_id=p_workspace AND r.id=p_reservation AND j.id=p_job AND e.id=p_event
    AND r.status='active' AND r.action_key=p_action
    AND o.kind='reserve' AND o.status='completed' AND o.idempotency_key='commercial.reserve:'||p_action
    AND o.request->>'action_key'=p_action AND o.result->>'entity_id'=r.id
    AND j.state='queued' AND t.state='plan_confirmed'
    AND p_action='model:generation:'||j.idempotency_key
    AND e.aggregate_id=j.id AND e.event_type='generation.requested' AND e.sequence=1
    AND e.payload->>'job_id'=j.id AND e.payload->>'task_id'=j.task_id
    AND e.payload->>'action_id'=p_action AND e.payload->>'context_hash'=v_intent
    AND e.payload->>'retry' IS DISTINCT FROM 'true'
    AND e.payload->'commercial_access_snapshot'->>'reservation_id'=r.id
    AND e.payload->'commercial_access_snapshot'->>'access_mode'='POINT_CHARGED'
    AND e.payload->'commercial_access_snapshot'->>'quoted_points'=r.points::text
    AND e.payload->'authorization_snapshot'->>'resource_id'=j.id
    AND e.payload->'authorization_snapshot'->>'authorized'='true'
    FOR SHARE OF r,o,j,t,e;
  IF NOT FOUND THEN RAISE EXCEPTION 'creative action enqueue binding invalid' USING ERRCODE='23514'; END IF;
  RETURN QUERY UPDATE public.creative_point_action_claims SET phase='bound',owner_token=NULL,lease_until=NULL,
    reservation_id=p_reservation,job_id=p_job,event_id=p_event,event_payload_sha256=v_payload_sha,updated_at=now()
    WHERE workspace_id=p_workspace AND action_key=p_action AND owner_token=p_token AND owner_epoch=p_epoch AND phase='leased'
    RETURNING public.creative_point_action_claims.*;
END $$;

CREATE FUNCTION release_unbound_creative_point_action(p_workspace text,p_action text,p_token text,p_epoch bigint)
RETURNS SETOF creative_point_action_claims LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'creative action tenant mismatch' USING ERRCODE='42501'; END IF;
  RETURN QUERY UPDATE public.creative_point_action_claims SET phase='available',owner_token=NULL,lease_until=NULL,updated_at=now()
    WHERE workspace_id=p_workspace AND action_key=p_action AND owner_token=p_token AND owner_epoch=p_epoch AND phase='leased'
    RETURNING public.creative_point_action_claims.*;
END $$;
REVOKE ALL ON FUNCTION claim_creative_point_action(text,text,text,bigint) FROM PUBLIC,merchant_app,merchant_ops;
REVOKE ALL ON FUNCTION bind_creative_point_action(text,text,text,bigint,text,text,text) FROM PUBLIC,merchant_app,merchant_ops;
REVOKE ALL ON FUNCTION release_unbound_creative_point_action(text,text,text,bigint) FROM PUBLIC,merchant_app,merchant_ops;
GRANT EXECUTE ON FUNCTION claim_creative_point_action(text,text,text,bigint) TO merchant_app;
GRANT EXECUTE ON FUNCTION bind_creative_point_action(text,text,text,bigint,text,text,text) TO merchant_app;
GRANT EXECUTE ON FUNCTION release_unbound_creative_point_action(text,text,text,bigint) TO merchant_app;
