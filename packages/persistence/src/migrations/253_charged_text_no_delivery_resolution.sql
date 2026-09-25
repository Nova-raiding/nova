-- A paid text response with no deliverable can be refunded exactly once by an
-- operator. The provider cost and its usage receipt remain immutable evidence.
CREATE TABLE charged_text_no_delivery_resolutions (
  workspace_id text NOT NULL,
  action_key text NOT NULL,
  reservation_id text NOT NULL,
  job_id text NOT NULL,
  event_id text NOT NULL,
  provider_request_id text NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  evidence_ref text NOT NULL,
  refunded_points integer NOT NULL CHECK (refunded_points > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,action_key),
  FOREIGN KEY (workspace_id,action_key) REFERENCES creative_point_action_claims(workspace_id,action_key) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,reservation_id) REFERENCES creative_point_reservations(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,job_id) REFERENCES generation_jobs(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,event_id) REFERENCES outbox_events(workspace_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX charged_text_no_delivery_reservation_unique ON charged_text_no_delivery_resolutions(workspace_id,reservation_id);
ALTER TABLE charged_text_no_delivery_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE charged_text_no_delivery_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY charged_text_no_delivery_workspace ON charged_text_no_delivery_resolutions
  USING (workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id=current_setting('app.workspace_id',true));
REVOKE ALL ON charged_text_no_delivery_resolutions FROM PUBLIC,merchant_app,merchant_ops;
-- The finance resolver sees only immutable dispatch evidence, never the
-- bearer-like owner token used to transition physical attempts.
GRANT SELECT (workspace_id,action_key,event_id,state,provider_request_id) ON charged_text_dispatch_attempts TO merchant_app;

-- Replays can read only the single tenant-scoped immutable resolution through
-- this function; the application role has no table-level access.
CREATE FUNCTION get_charged_text_no_delivery_resolution(p_workspace text,p_action text)
RETURNS SETOF charged_text_no_delivery_resolutions LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'charged text resolution workspace mismatch' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT r.* FROM public.charged_text_no_delivery_resolutions r
    WHERE r.workspace_id=p_workspace AND r.action_key=p_action;
END $$;

CREATE FUNCTION insert_charged_text_no_delivery_resolution(p_workspace text,p_action text,p_reservation text,
  p_job text,p_event text,p_provider_request text,p_actor text,p_reason text,p_evidence_ref text,p_points integer)
RETURNS SETOF charged_text_no_delivery_resolutions LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'charged text resolution workspace mismatch' USING ERRCODE='42501'; END IF;
  IF p_actor IS NULL OR length(trim(p_actor)) NOT BETWEEN 1 AND 128 OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 4 AND 1000
    OR p_evidence_ref IS NULL OR length(trim(p_evidence_ref)) NOT BETWEEN 1 AND 255
    OR p_provider_request IS NULL OR length(trim(p_provider_request)) NOT BETWEEN 1 AND 256
    OR p_points IS NULL OR p_points <= 0 THEN
    RAISE EXCEPTION 'charged text resolution evidence invalid' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.creative_point_action_claims c
    JOIN public.creative_point_reservations r ON r.workspace_id=c.workspace_id AND r.id=c.reservation_id
    JOIN public.generation_jobs j ON j.workspace_id=c.workspace_id AND j.id=c.job_id
    JOIN public.outbox_events e ON e.workspace_id=c.workspace_id AND e.id=c.event_id
    JOIN public.charged_text_dispatch_attempts a ON a.workspace_id=c.workspace_id AND a.action_key=c.action_key AND a.event_id=c.event_id
    JOIN public.model_usage_ledger m ON m.workspace_id=c.workspace_id AND m.action_id=c.action_key AND m.provider_request_id=p_provider_request
    JOIN public.creative_point_provider_receipts_v2 api ON api.workspace_id=r.workspace_id AND api.operation_id=r.operation_id
      AND api.provider='model-relay' AND api.provider_request_id=p_provider_request
    JOIN public.creative_point_provider_receipts_v2 worker ON worker.workspace_id=r.workspace_id AND worker.operation_id=r.operation_id
      AND worker.provider<>'model-relay' AND worker.provider_request_id=p_provider_request
    JOIN public.creative_point_reversals_v2 refund ON refund.workspace_id=r.workspace_id
      AND refund.original_reservation_id=r.id AND refund.reversal_kind='refund' AND refund.points=p_points
    JOIN public.creative_point_operations refund_op ON refund_op.workspace_id=refund.workspace_id AND refund_op.id=refund.operation_id
      AND refund_op.kind='refund' AND refund_op.status='completed' AND refund_op.idempotency_key='charged-text-no-delivery:'||p_action
    WHERE c.workspace_id=p_workspace AND c.action_key=p_action AND c.phase='bound'
      AND c.reservation_id=p_reservation AND c.job_id=p_job AND c.event_id=p_event
      AND r.status='settled' AND r.settled_points=p_points
      AND j.state IN ('queued','running') AND j.content_version_id IS NULL
      AND e.event_type='generation.requested' AND e.aggregate_id=j.id
      AND c.event_payload_sha256=encode(digest(e.payload::text,'sha256'),'hex')
      AND e.unknown_at IS NOT NULL AND e.last_error->>'code'='CHARGED_TEXT_SCHEMA_REPAIR_DISABLED'
      AND a.state='completed' AND a.provider_request_id=p_provider_request
      AND m.modality='text' AND m.settlement_status='settled' AND m.cost_cny IS NOT NULL
      AND api.outcome='succeeded' AND api.verified_at IS NOT NULL
      AND worker.outcome='succeeded' AND worker.verified_at IS NOT NULL
    FOR UPDATE OF c,r,j,e,a,m,api,worker,refund,refund_op;
  IF NOT FOUND THEN RAISE EXCEPTION 'charged text no-delivery evidence mismatch' USING ERRCODE='23514'; END IF;
  RETURN QUERY INSERT INTO public.charged_text_no_delivery_resolutions
    (workspace_id,action_key,reservation_id,job_id,event_id,provider_request_id,actor_id,reason,evidence_ref,refunded_points)
    VALUES(p_workspace,p_action,p_reservation,p_job,p_event,p_provider_request,p_actor,p_reason,p_evidence_ref,p_points)
    ON CONFLICT (workspace_id,action_key) DO NOTHING
    RETURNING public.charged_text_no_delivery_resolutions.*;
END $$;

-- A refunded no-delivery job may never be requeued or upgraded to success.
CREATE FUNCTION guard_charged_text_no_delivery_job() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.state <> 'failed' AND EXISTS (SELECT 1 FROM public.charged_text_no_delivery_resolutions r
      WHERE r.workspace_id=NEW.workspace_id AND r.job_id=NEW.id) THEN
    RAISE EXCEPTION 'refunded no-delivery generation cannot restart' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER charged_text_no_delivery_job_guard BEFORE UPDATE OF state ON generation_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_charged_text_no_delivery_job();
REVOKE ALL ON FUNCTION insert_charged_text_no_delivery_resolution(text,text,text,text,text,text,text,text,text,integer) FROM PUBLIC,merchant_app,merchant_ops;
REVOKE ALL ON FUNCTION get_charged_text_no_delivery_resolution(text,text) FROM PUBLIC,merchant_app,merchant_ops;
GRANT EXECUTE ON FUNCTION insert_charged_text_no_delivery_resolution(text,text,text,text,text,text,text,text,text,integer) TO merchant_app;
GRANT EXECUTE ON FUNCTION get_charged_text_no_delivery_resolution(text,text) TO merchant_app;
