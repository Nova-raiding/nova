-- Preserve historical payment/training facts while allowing their evidence to
-- be repaired one group at a time. Unchanged legacy groups remain incomplete;
-- new or changed groups must satisfy the evidence contract. Asset existence,
-- tenant ownership and scan status are verified by the application asset gate.
ALTER TABLE workspace_customer_deliveries
  DROP CONSTRAINT IF EXISTS customer_delivery_paid_evidence_required,
  DROP CONSTRAINT IF EXISTS customer_delivery_training_evidence_required;

CREATE OR REPLACE FUNCTION public.enforce_customer_delivery_evidence_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $customer_delivery_evidence_transition$
DECLARE
  -- Match JavaScript String.trim without relying on the database locale.
  evidence_whitespace CONSTANT TEXT := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  payment_facts_changed BOOLEAN := TG_OP = 'INSERT';
  training_facts_changed BOOLEAN := TG_OP = 'INSERT';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    payment_facts_changed :=
      ROW(NEW.payment_status, NEW.payment_date, NEW.payment_evidence_refs)
      IS DISTINCT FROM ROW(OLD.payment_status, OLD.payment_date, OLD.payment_evidence_refs);
    training_facts_changed :=
      ROW(NEW.training_completed, NEW.training_evidence_refs)
      IS DISTINCT FROM ROW(OLD.training_completed, OLD.training_evidence_refs);
  END IF;

  IF payment_facts_changed THEN
    IF NEW.payment_evidence_refs IS NULL OR EXISTS (
      SELECT 1 FROM unnest(NEW.payment_evidence_refs) AS evidence_ref(value)
      WHERE evidence_ref.value IS NULL OR btrim(evidence_ref.value, evidence_whitespace) = ''
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'customer_delivery_paid_evidence_required',
        MESSAGE = 'payment evidence references must be nonempty strings';
    END IF;
    IF NEW.payment_status = 'paid'
      AND (NEW.payment_date IS NULL OR cardinality(NEW.payment_evidence_refs) = 0) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'customer_delivery_paid_evidence_required',
        MESSAGE = 'paid customer delivery requires a payment date and evidence references';
    END IF;
  END IF;

  IF training_facts_changed THEN
    IF NEW.training_evidence_refs IS NULL OR EXISTS (
      SELECT 1 FROM unnest(NEW.training_evidence_refs) AS evidence_ref(value)
      WHERE evidence_ref.value IS NULL OR btrim(evidence_ref.value, evidence_whitespace) = ''
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'customer_delivery_training_evidence_required',
        MESSAGE = 'training evidence references must be nonempty strings';
    END IF;
    IF NEW.training_completed AND cardinality(NEW.training_evidence_refs) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'customer_delivery_training_evidence_required',
        MESSAGE = 'completed customer training requires evidence references';
    END IF;
  END IF;

  RETURN NEW;
END;
$customer_delivery_evidence_transition$;

DROP TRIGGER IF EXISTS workspace_customer_delivery_evidence_transition_guard
  ON workspace_customer_deliveries;
CREATE TRIGGER workspace_customer_delivery_evidence_transition_guard
  BEFORE INSERT OR UPDATE ON workspace_customer_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_customer_delivery_evidence_transition();
