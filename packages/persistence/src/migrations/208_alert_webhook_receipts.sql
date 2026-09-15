CREATE TABLE alert_webhook_receipts (
  request_id text PRIMARY KEY CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  alert_id text NOT NULL UNIQUE CHECK (alert_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  received_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT alert_webhook_receipts_payload_request_id_matches
    CHECK (payload @> jsonb_build_object('request_id', request_id)),
  CONSTRAINT alert_webhook_receipts_payload_alert_id_matches
    CHECK (payload @> jsonb_build_object('alert', jsonb_build_object('id', alert_id)))
);

REVOKE ALL ON alert_webhook_receipts FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL PRIVILEGES ON alert_webhook_receipts FROM merchant_ops;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_alert_webhook_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$ BEGIN
  RAISE EXCEPTION 'alert webhook receipts are append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER alert_webhook_receipts_append_only
BEFORE UPDATE OR DELETE ON alert_webhook_receipts FOR EACH ROW EXECUTE FUNCTION reject_alert_webhook_receipt_mutation();
CREATE TRIGGER alert_webhook_receipts_no_truncate
BEFORE TRUNCATE ON alert_webhook_receipts FOR EACH STATEMENT EXECUTE FUNCTION reject_alert_webhook_receipt_mutation();

REVOKE ALL ON FUNCTION reject_alert_webhook_receipt_mutation() FROM PUBLIC;
