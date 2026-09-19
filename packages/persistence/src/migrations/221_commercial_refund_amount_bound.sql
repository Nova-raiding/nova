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
-- 220 stays in the chain as written and is not edited into a different
-- mechanism: migrations are append-only history, so the repair is a
-- CREATE OR REPLACE that supersedes 220's function body in the same chain.
-- 220's body runs first and is then replaced here, which means the amount
-- based body below is the only body any database ever installs, and only 220's
-- header comment (which over-claimed what its trigger enforced) was corrected.
--
-- Only 'approved' and 'completed' events commit money. The order-status check
-- still applies to 'completed' only: an order that already left 'paid' must
-- never be paid out again.
--
-- What actually enforces the bound: the per-order row lock, taken on
-- commercial_orders_v2, that every money-committing writer shares with
-- commercial-refund-repository.ts (which locks the same row FOR UPDATE before
-- it reads the committed sum in committedIn()). The trigger below takes that
-- lock on the order row before it computes the bound. Without the lock the
-- trigger was not a backstop at all: its two SELECTs are plain reads, and in
-- READ COMMITTED a plain read cannot see another transaction's uncommitted
-- rows, so two writers could each append a full-amount 'approved' chain for the
-- same paid order, each pass this check against the same unrefunded snapshot,
-- and both commit (paid = 500000 while committed = 1000000; reproduced on
-- PostgreSQL with two connections). The lock - not the trigger alone - is what
-- makes the concurrent write impossible.
--
-- Taking the lock requires the UPDATE privilege on commercial_orders_v2, the
-- same privilege the repository path already needs for its own FOR UPDATE. The
-- runtime role (merchant_app) holds it, and merchant_ops cannot write these
-- events at all (171 revoked that). A hypothetical writer holding INSERT on the
-- event table but not UPDATE on the order table now fails closed with 42501
-- instead of bypassing the bound.
--
-- The per-request maximum is what the repository mirrors in committedIn(); the
-- trigger restates it for writers that bypass the repository, and serializes
-- with them on the same order row, so the bound holds for every writer.

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

  -- Serialize every money-committing write for this order on the order row,
  -- with the same lock and the same lock order as the repository (order row
  -- first, event row after). A concurrent writer that already holds the lock
  -- makes this statement wait; once it commits, the reads below run against a
  -- fresh snapshot and see its committed chains. Re-locking a row this
  -- transaction already holds is a no-op, so nested calls are free.
  PERFORM 1 FROM commercial_orders_v2
   WHERE workspace_id = NEW.workspace_id AND id = NEW.order_id
     FOR UPDATE;

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
