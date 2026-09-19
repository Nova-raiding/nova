-- 221_commercial_refund_amount_bound: forward-only repair of the database
-- backstop added by 220. 220 decided how much money a refund request had
-- committed by looking at that request's *highest revision* and keeping it only
-- when that revision was an 'approved'/'completed' event. Appending any later
-- non-money revision ('requested', 'rejected', 'reconciliation_required') to an
-- already approved request therefore erased its money from the bound, and a
-- second full-amount chain could then be approved and paid out: a writable
-- session could reach paid = 500000 with completed = 1000000.
--
-- The invariant is restated over amounts instead of over the identity of the
-- highest revision: a request commits the maximum amount it has *ever* been
-- approved or completed for. Because the event table is append-only (170
-- rejects UPDATE/DELETE/TRUNCATE), the per-request maximum is monotone
-- non-decreasing: no later insert can lower it, so no later insert can release
-- money that was already committed. An approved-then-completed request is still
-- counted once, since both of its revisions carry the same amount.
--
-- 220 stays byte-for-byte intact because it is a released artifact: a database
-- that already applied it recorded its checksum, and editing the file would
-- fail migration.ts verification with MIGRATION_CHECKSUM_MISMATCH instead of
-- upgrading. This migration CREATE OR REPLACEs the function so every database
-- converges to the corrected bound: 220's body is executed first and is then
-- superseded here in the same chain.
--
-- Only 'approved' and 'completed' events commit money. The order-status check
-- still applies to 'completed' only: an order that already left 'paid' must
-- never be paid out again.
--
-- The per-request maximum is what the repository mirrors in committedIn(); the
-- trigger remains the independent backstop for writers that bypass it.

CREATE OR REPLACE FUNCTION enforce_commercial_refund_cumulative_bound()
RETURNS trigger LANGUAGE plpgsql AS $commercial_refund_cumulative_bound$
DECLARE
  order_amount_fen bigint;
  order_status text;
  other_requests_fen bigint;
  own_request_fen bigint;
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

  -- Every other request for this order: the largest amount it has ever been
  -- approved or completed for. A later non-money revision cannot erase it.
  SELECT COALESCE(SUM(chain.amount_fen), 0) INTO other_requests_fen
    FROM (
      SELECT request_id, MAX(amount_fen) AS amount_fen
        FROM commercial_refund_events_v2
       WHERE workspace_id = NEW.workspace_id AND order_id = NEW.order_id
         AND event_type IN ('approved', 'completed')
       GROUP BY request_id
    ) chain
   WHERE chain.request_id <> NEW.request_id;

  -- The inserting request's own footprint, including the row being inserted.
  SELECT COALESCE(MAX(amount_fen), 0) INTO own_request_fen
    FROM commercial_refund_events_v2
   WHERE workspace_id = NEW.workspace_id AND order_id = NEW.order_id
     AND request_id = NEW.request_id AND event_type IN ('approved', 'completed');

  IF other_requests_fen + GREATEST(own_request_fen, NEW.amount_fen) > order_amount_fen THEN
    RAISE EXCEPTION 'commercial refund exceeds the paid order amount (% > %)',
      other_requests_fen + GREATEST(own_request_fen, NEW.amount_fen), order_amount_fen
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$commercial_refund_cumulative_bound$;

DROP TRIGGER IF EXISTS commercial_refund_events_v2_cumulative_bound ON commercial_refund_events_v2;
CREATE TRIGGER commercial_refund_events_v2_cumulative_bound
  BEFORE INSERT ON commercial_refund_events_v2
  FOR EACH ROW EXECUTE FUNCTION enforce_commercial_refund_cumulative_bound();
