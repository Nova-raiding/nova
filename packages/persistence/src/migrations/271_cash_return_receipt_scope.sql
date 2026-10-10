-- A receipt's source fact keeps its original nullable workspace forever. The
-- balance projection is the authoritative tenant scope after an unmatched
-- receipt is matched, so returns must reference that projection.
DO $cash_return_scope_preflight$
BEGIN
 IF EXISTS (
   SELECT 1
   FROM commercial_cash_returns_v2 r
   LEFT JOIN commercial_cash_receipt_balances_v2 b ON b.receipt_id=r.receipt_id
   JOIN commercial_cash_receipts_v2 f ON f.id=r.receipt_id
   WHERE b.receipt_id IS NULL
     OR (r.workspace_id IS NULL
       AND b.workspace_id IS NOT NULL
       AND NOT (f.workspace_id IS NULL AND r.status IN ('completed','rejected')))
 ) THEN
   RAISE EXCEPTION 'cash return has missing balance or unresolved/inconsistent NULL tenant scope; reconcile before migration 271'
     USING ERRCODE='23514';
 END IF;
END $cash_return_scope_preflight$;

ALTER TABLE commercial_cash_returns_v2
  ADD CONSTRAINT commercial_cash_returns_receipt_scope_fk
  FOREIGN KEY (workspace_id, receipt_id)
  REFERENCES commercial_cash_receipt_balances_v2 (workspace_id, receipt_id);

-- MATCH SIMPLE intentionally permits NULL-workspace returns for unmatched
-- balances. Close its NULL escape hatch after matching: new or changed return
-- rows must have exactly the balance's current scope. Historical terminal
-- unmatched returns remain NULL after a later match and are left untouched.
CREATE FUNCTION enforce_commercial_cash_return_scope_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance_workspace text;
BEGIN
 SELECT b.workspace_id INTO balance_workspace
 FROM commercial_cash_receipt_balances_v2 b
 WHERE b.receipt_id=NEW.receipt_id
 FOR KEY SHARE;
 IF NOT FOUND OR NEW.workspace_id IS DISTINCT FROM balance_workspace THEN
   RAISE EXCEPTION 'cash return scope differs from receipt balance scope'
     USING ERRCODE='23503', CONSTRAINT='commercial_cash_returns_receipt_scope_fk';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commercial_cash_return_scope_guard
 BEFORE INSERT OR UPDATE ON commercial_cash_returns_v2
 FOR EACH ROW EXECUTE FUNCTION enforce_commercial_cash_return_scope_v2();

-- Matching is allowed only after every return request has a terminal
-- disposition; enforce that invariant for direct SQL updates as well.
CREATE FUNCTION guard_commercial_cash_balance_match_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
   IF OLD.workspace_id IS NOT NULL THEN
     RAISE EXCEPTION 'matched cash receipt tenant scope is immutable' USING ERRCODE='23514';
   END IF;
   IF NEW.workspace_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM commercial_cash_receipt_matches_v2 m
     WHERE m.receipt_id=NEW.receipt_id AND m.workspace_id=NEW.workspace_id
   ) THEN
     RAISE EXCEPTION 'cash receipt tenant scope requires matching evidence' USING ERRCODE='23514';
   END IF;
   IF NEW.workspace_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM commercial_cash_returns_v2 r
     WHERE r.receipt_id=NEW.receipt_id AND r.status NOT IN ('completed','rejected')
   ) THEN
     RAISE EXCEPTION 'unmatched receipt has unresolved return disposition'
       USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commercial_cash_balance_match_guard
 BEFORE UPDATE OF workspace_id ON commercial_cash_receipt_balances_v2
 FOR EACH ROW EXECUTE FUNCTION guard_commercial_cash_balance_match_v2();
