-- Operations staff confirm payment and checklist completion manually. Evidence
-- remains attachable and is still validated when supplied, but it is optional.
ALTER TABLE workspace_customer_deliveries
  DROP CONSTRAINT IF EXISTS customer_delivery_paid_evidence_required;

CREATE OR REPLACE FUNCTION public.enforce_customer_delivery_evidence_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $customer_delivery_evidence_transition$
DECLARE
  evidence_whitespace CONSTANT TEXT := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  payment_evidence_changed BOOLEAN := TG_OP = 'INSERT';
  training_evidence_changed BOOLEAN := TG_OP = 'INSERT';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    payment_evidence_changed :=
      NEW.payment_evidence_refs IS DISTINCT FROM OLD.payment_evidence_refs;
    training_evidence_changed :=
      NEW.training_evidence_refs IS DISTINCT FROM OLD.training_evidence_refs;
  END IF;

  IF payment_evidence_changed AND (
    NEW.payment_evidence_refs IS NULL OR EXISTS (
      SELECT 1 FROM unnest(NEW.payment_evidence_refs) AS evidence_ref(value)
      WHERE evidence_ref.value IS NULL OR btrim(evidence_ref.value, evidence_whitespace) = ''
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'customer_delivery_paid_evidence_required',
      MESSAGE = 'payment evidence references must be nonempty strings';
  END IF;

  IF training_evidence_changed AND (
    NEW.training_evidence_refs IS NULL OR EXISTS (
      SELECT 1 FROM unnest(NEW.training_evidence_refs) AS evidence_ref(value)
      WHERE evidence_ref.value IS NULL OR btrim(evidence_ref.value, evidence_whitespace) = ''
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'customer_delivery_training_evidence_required',
      MESSAGE = 'training evidence references must be nonempty strings';
  END IF;

  RETURN NEW;
END;
$customer_delivery_evidence_transition$;
