-- 220_commercial_refund_cumulative_bound: the database-level backstop for the
-- commercial refund invariant "the sum of every refund that reaches an
-- approved/completed state for one order may never exceed the amount the
-- customer actually paid on that order".
--
-- The repository takes a row lock on commercial_orders_v2 and re-reads the
-- committed sum before every decision, but a second writer (an operations
-- script, a future endpoint, a restored replica) could still append an
-- approved/completed event directly. This trigger makes that impossible: it
-- counts each request at its highest revision only, so an approved request
-- that is later completed is never counted twice.
--
-- Only 'approved' and 'completed' events commit money. 'requested',
-- 'rejected' and 'reconciliation_required' rows stay unconstrained so that a
-- request can be raised and rejected freely. The order status check applies
-- to 'completed' only: a refund that has already moved the order out of
-- 'paid' must never be paid out a second time.

CREATE OR REPLACE FUNCTION enforce_commercial_refund_cumulative_bound()
RETURNS trigger LANGUAGE plpgsql AS $commercial_refund_cumulative_bound$
DECLARE
  order_amount_fen bigint;
  order_status text;
  committed_fen bigint;
BEGIN
  IF NEW.event_type NOT IN ('approved', 'completed') THEN
    RETURN NEW;
  END IF;

  -- A missing order row (or a session without workspace scope) is left to the
  -- foreign key and the row-level security policy; this trigger never invents
  -- a bound it cannot prove.
  SELECT amount_fen, status INTO order_amount_fen, order_status
    FROM commercial_orders_v2
   WHERE workspace_id = NEW.workspace_id AND id = NEW.order_id;
  IF order_amount_fen IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type = 'completed' AND order_status <> 'paid' THEN
    RAISE EXCEPTION 'commercial order % is % and cannot complete another refund', NEW.order_id, order_status
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(latest.amount_fen), 0) INTO committed_fen
    FROM (
      SELECT DISTINCT ON (request_id) request_id, event_type, amount_fen
        FROM commercial_refund_events_v2
       WHERE workspace_id = NEW.workspace_id AND order_id = NEW.order_id
       ORDER BY request_id, revision DESC
    ) latest
   WHERE latest.event_type IN ('approved', 'completed')
     AND latest.request_id <> NEW.request_id;

  IF committed_fen + NEW.amount_fen > order_amount_fen THEN
    RAISE EXCEPTION 'commercial refund exceeds the paid order amount (% > %)',
      committed_fen + NEW.amount_fen, order_amount_fen
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$commercial_refund_cumulative_bound$;

DROP TRIGGER IF EXISTS commercial_refund_events_v2_cumulative_bound ON commercial_refund_events_v2;
CREATE TRIGGER commercial_refund_events_v2_cumulative_bound
  BEFORE INSERT ON commercial_refund_events_v2
  FOR EACH ROW EXECUTE FUNCTION enforce_commercial_refund_cumulative_bound();
