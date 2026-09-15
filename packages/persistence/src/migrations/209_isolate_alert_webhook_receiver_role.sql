DO $$
DECLARE
  receiver_role record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreatedb, rolcreaterole, rolreplication
    INTO receiver_role
    FROM pg_catalog.pg_roles
   WHERE rolname = 'merchant_alert_receiver';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'merchant_alert_receiver role must be provisioned before migration 209'
      USING ERRCODE = '42501';
  END IF;
  IF NOT receiver_role.rolcanlogin
     OR receiver_role.rolsuper
     OR receiver_role.rolbypassrls
     OR receiver_role.rolinherit
     OR receiver_role.rolcreatedb
     OR receiver_role.rolcreaterole
     OR receiver_role.rolreplication THEN
    RAISE EXCEPTION 'merchant_alert_receiver role has unsafe attributes'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
     WHERE member_role.rolname = 'merchant_alert_receiver'
  ) THEN
    RAISE EXCEPTION 'merchant_alert_receiver role must not be a member of another role'
      USING ERRCODE = '42501';
  END IF;
END $$;

REVOKE ALL PRIVILEGES ON TABLE public.alert_webhook_receipts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.alert_webhook_receipts FROM merchant_app;
REVOKE ALL PRIVILEGES ON TABLE public.alert_webhook_receipts FROM merchant_ops;
REVOKE ALL PRIVILEGES ON TABLE public.alert_webhook_receipts FROM merchant_alert_receiver;

CREATE OR REPLACE FUNCTION public.append_alert_webhook_receipt(
  p_alert_id text,
  p_request_id text,
  p_received_at timestamptz,
  p_sent_at timestamptz,
  p_body_sha256 text,
  p_payload jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  inserted_count integer;
BEGIN
  IF SESSION_USER <> 'merchant_alert_receiver' THEN
    RAISE EXCEPTION 'alert webhook receipt append is restricted to merchant_alert_receiver'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.alert_webhook_receipts (
    alert_id, request_id, received_at, sent_at, body_sha256, payload
  ) VALUES (
    p_alert_id, p_request_id, p_received_at, p_sent_at, p_body_sha256, p_payload
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count = 1;
END $$;

CREATE OR REPLACE FUNCTION public.alert_webhook_receipts_ready() RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF SESSION_USER <> 'merchant_alert_receiver' THEN
    RAISE EXCEPTION 'alert webhook receipt readiness is restricted to merchant_alert_receiver'
      USING ERRCODE = '42501';
  END IF;
  RETURN pg_catalog.to_regclass('public.alert_webhook_receipts') IS NOT NULL;
END $$;

REVOKE ALL PRIVILEGES ON FUNCTION public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb) FROM merchant_app;
REVOKE ALL PRIVILEGES ON FUNCTION public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb) FROM merchant_ops;
REVOKE ALL PRIVILEGES ON FUNCTION public.alert_webhook_receipts_ready() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.alert_webhook_receipts_ready() FROM merchant_app;
REVOKE ALL PRIVILEGES ON FUNCTION public.alert_webhook_receipts_ready() FROM merchant_ops;

GRANT EXECUTE ON FUNCTION public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb) TO merchant_alert_receiver;
GRANT EXECUTE ON FUNCTION public.alert_webhook_receipts_ready() TO merchant_alert_receiver;
