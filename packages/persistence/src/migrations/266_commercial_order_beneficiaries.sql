-- Bind operator-assisted purchases to one verified merchant member. Legacy
-- orders remain NULL because no reliable recipient can be inferred safely.
ALTER TABLE commercial_order_terms_v3
  ADD COLUMN beneficiary_member_id UUID;

ALTER TABLE commercial_order_terms_v3
  ADD CONSTRAINT commercial_order_terms_v3_beneficiary_fk
  FOREIGN KEY(workspace_id,beneficiary_member_id)
  REFERENCES workspace_members(workspace_id,id);

CREATE INDEX commercial_order_terms_v3_beneficiary_idx
  ON commercial_order_terms_v3(workspace_id,beneficiary_member_id,order_id)
  WHERE beneficiary_member_id IS NOT NULL;

ALTER TABLE commercial_purchase_result_notification_outbox
  ADD COLUMN beneficiary_member_id UUID;

ALTER TABLE commercial_purchase_result_notification_outbox
  ADD CONSTRAINT commercial_purchase_result_beneficiary_fk
  FOREIGN KEY(workspace_id,beneficiary_member_id)
  REFERENCES workspace_members(workspace_id,id);

CREATE OR REPLACE FUNCTION guard_commercial_result_notification_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.source_event_id,NEW.order_id,NEW.result_state,NEW.sku_code,NEW.version,NEW.visibility,NEW.payload,NEW.created_at,NEW.beneficiary_member_id)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.source_event_id,OLD.order_id,OLD.result_state,OLD.sku_code,OLD.version,OLD.visibility,OLD.payload,OLD.created_at,OLD.beneficiary_member_id) THEN
 RAISE EXCEPTION 'commercial result notification facts are immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.merchant_commercial_order_beneficiary(p_order_id text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET row_security=off AS $$
 SELECT t.beneficiary_member_id
 FROM public.commercial_order_terms_v3 t
 WHERE t.workspace_id=current_setting('app.workspace_id',true) AND t.order_id=p_order_id
$$;
REVOKE ALL ON FUNCTION public.merchant_commercial_order_beneficiary(text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
  GRANT EXECUTE ON FUNCTION public.merchant_commercial_order_beneficiary(text) TO merchant_ops;
 END IF;
END $$;
