-- The first-install Demo grant is append-only for application roles, but the
-- privileged Demo evaluation tool must be able to close an expired active row
-- before issuing the next bounded evaluation window. This keeps the unique
-- active-grant index and prevents merchant_app/merchant_ops from mutating it.
CREATE OR REPLACE FUNCTION reject_demo_evaluation_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.demo_evaluation_admin', true) = 'true'
     AND current_user NOT IN ('merchant_app', 'merchant_ops', 'merchant_alert_receiver') THEN
    IF TG_OP = 'UPDATE'
       AND OLD.status = 'active'
       AND NEW.status = 'revoked'
       AND OLD.workspace_id = NEW.workspace_id
       AND OLD.id = NEW.id THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'demo evaluation grant is immutable';
END;
$$;
