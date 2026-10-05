-- A delivery projection over real committed commercial payment/outbox facts.
-- It never creates a payment, qualification, subscription, or point grant.
CREATE TABLE commercial_purchase_result_notification_outbox (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 source_event_id TEXT NOT NULL,
 order_id TEXT NOT NULL,
 result_state TEXT NOT NULL CHECK(result_state IN ('active','scheduled','awaiting_dependency','reconciliation_required')),
 sku_code TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
 payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536),
 created_at TIMESTAMPTZ NOT NULL,
 cursor_member_id TEXT NOT NULL DEFAULT '',
 lease_token TEXT,
 lease_until TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 PRIMARY KEY(workspace_id,source_event_id),
 FOREIGN KEY(source_event_id,workspace_id) REFERENCES outbox_events(id,workspace_id),
 FOREIGN KEY(workspace_id,order_id) REFERENCES commercial_orders_v2(workspace_id,id),
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX commercial_purchase_result_notification_sources_idx ON outbox_events(workspace_id,created_at,id) WHERE event_type IN ('commercial.payment.active','commercial.payment.scheduled','commercial.payment.awaiting_dependency','commercial.payment.reconciliation_required');
CREATE INDEX commercial_purchase_result_notification_pending_idx ON commercial_purchase_result_notification_outbox(workspace_id,created_at,source_event_id) WHERE completed_at IS NULL;
CREATE TABLE workspace_commercial_result_notifications (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 member_id UUID NOT NULL,
 source_event_id TEXT NOT NULL,
 order_id TEXT NOT NULL,
 result_state TEXT NOT NULL CHECK(result_state IN ('active','scheduled','awaiting_dependency','reconciliation_required')),
 sku_code TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
 payload JSONB NOT NULL,
 published_at TIMESTAMPTZ NOT NULL,
 delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,member_id,source_event_id),
 FOREIGN KEY(workspace_id,source_event_id) REFERENCES commercial_purchase_result_notification_outbox(workspace_id,source_event_id),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspace_members(workspace_id,id)
);
CREATE INDEX workspace_commercial_result_notifications_page_idx ON workspace_commercial_result_notifications(workspace_id,member_id,published_at DESC,source_event_id DESC);
CREATE TABLE workspace_commercial_notification_reads (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 member_id UUID NOT NULL,
 notification_id TEXT NOT NULL CHECK(length(notification_id) BETWEEN 1 AND 400),
 read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,member_id,notification_id),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspace_members(workspace_id,id)
);
CREATE TABLE workspace_commercial_notification_read_requests (
 workspace_id TEXT NOT NULL,
 member_id UUID NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 notification_id TEXT NOT NULL,
 read_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(workspace_id,member_id,idempotency_key),
 FOREIGN KEY(workspace_id,member_id,notification_id) REFERENCES workspace_commercial_notification_reads(workspace_id,member_id,notification_id)
);
ALTER TABLE commercial_purchase_result_notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_purchase_result_notification_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_purchase_result_notification_outbox_scope ON commercial_purchase_result_notification_outbox USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
DO $$ DECLARE relation_name TEXT; BEGIN
 FOREACH relation_name IN ARRAY ARRAY['workspace_commercial_result_notifications','workspace_commercial_notification_reads','workspace_commercial_notification_read_requests'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('CREATE POLICY %I ON %I USING(workspace_id=current_setting(''app.workspace_id'',true) AND (member_id::text=current_setting(''app.member_id'',true) OR current_user=''merchant_ops'')) WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true) AND (member_id::text=current_setting(''app.member_id'',true) OR current_user=''merchant_ops''))',relation_name||'_scope',relation_name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_commercial_catalog_fact_mutation()',relation_name||'_immutable',relation_name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation_name);
 END LOOP;
END; $$;
CREATE FUNCTION guard_commercial_result_notification_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.source_event_id,NEW.order_id,NEW.result_state,NEW.sku_code,NEW.version,NEW.visibility,NEW.payload,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.source_event_id,OLD.order_id,OLD.result_state,OLD.sku_code,OLD.version,OLD.visibility,OLD.payload,OLD.created_at) THEN
 RAISE EXCEPTION 'commercial result notification facts are immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER commercial_result_notification_content_immutable BEFORE UPDATE ON commercial_purchase_result_notification_outbox FOR EACH ROW EXECUTE FUNCTION guard_commercial_result_notification_content();
REVOKE ALL ON commercial_purchase_result_notification_outbox FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
  REVOKE ALL ON commercial_purchase_result_notification_outbox FROM merchant_app;
  GRANT SELECT ON workspace_commercial_result_notifications TO merchant_app;
  GRANT SELECT,INSERT ON workspace_commercial_notification_reads,workspace_commercial_notification_read_requests TO merchant_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
  GRANT SELECT,INSERT,UPDATE ON commercial_purchase_result_notification_outbox TO merchant_ops;
  GRANT SELECT,INSERT ON workspace_commercial_result_notifications TO merchant_ops;
  GRANT SELECT ON outbox_events,commercial_payment_events_v2,commercial_order_snapshots_v2,commercial_orders_v2 TO merchant_ops;
 END IF;
END; $$;
