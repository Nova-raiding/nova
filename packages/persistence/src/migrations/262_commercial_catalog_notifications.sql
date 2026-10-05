-- Publish inserts one event in the catalog transaction. Fanout is durable and bounded.
CREATE TABLE commercial_catalog_publish_outbox (
  event_id UUID PRIMARY KEY,
  sku_code TEXT NOT NULL REFERENCES commercial_catalog_skus(code),
  version INTEGER NOT NULL CHECK (version > 0),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
  audience_workspace_id TEXT REFERENCES workspaces(id),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cursor_member_id TEXT NOT NULL DEFAULT '',
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX commercial_catalog_publish_pending_idx ON commercial_catalog_publish_outbox(created_at,event_id) WHERE completed_at IS NULL;
CREATE TABLE workspace_commercial_notifications (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  member_id UUID NOT NULL,
  event_id UUID NOT NULL REFERENCES commercial_catalog_publish_outbox(event_id),
  sku_code TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id,member_id),
  FOREIGN KEY(workspace_id,member_id) REFERENCES workspace_members(workspace_id,id)
);
CREATE INDEX workspace_commercial_notifications_page_idx ON workspace_commercial_notifications(workspace_id,member_id,published_at DESC,event_id DESC);
ALTER TABLE workspace_commercial_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_commercial_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_commercial_notifications_scope ON workspace_commercial_notifications USING(workspace_id=current_setting('app.workspace_id',true) AND (member_id::text=current_setting('app.member_id',true) OR current_user='merchant_ops')) WITH CHECK(workspace_id=current_setting('app.workspace_id',true) AND current_user='merchant_ops');
CREATE FUNCTION guard_commercial_publish_outbox_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.event_id,NEW.sku_code,NEW.version,NEW.visibility,NEW.audience_workspace_id,NEW.payload,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.event_id,OLD.sku_code,OLD.version,OLD.visibility,OLD.audience_workspace_id,OLD.payload,OLD.created_at) THEN
 RAISE EXCEPTION 'commercial publication facts are immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER commercial_publish_outbox_content_immutable BEFORE UPDATE ON commercial_catalog_publish_outbox FOR EACH ROW EXECUTE FUNCTION guard_commercial_publish_outbox_content();
CREATE TRIGGER commercial_notifications_immutable BEFORE UPDATE OR DELETE ON workspace_commercial_notifications FOR EACH ROW EXECUTE FUNCTION reject_commercial_catalog_fact_mutation();
REVOKE ALL ON commercial_catalog_publish_outbox,workspace_commercial_notifications FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
 GRANT SELECT,INSERT,UPDATE ON commercial_catalog_publish_outbox TO merchant_ops;
 GRANT SELECT,INSERT ON workspace_commercial_notifications TO merchant_ops;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
 REVOKE ALL ON commercial_catalog_publish_outbox FROM merchant_app;
 GRANT SELECT ON workspace_commercial_notifications TO merchant_app;
 END IF;
END; $$;
