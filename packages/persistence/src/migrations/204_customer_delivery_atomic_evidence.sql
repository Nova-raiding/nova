-- Make delivery evidence attachment and revocation database-atomic. The
-- validator locks the current asset snapshot for the caller's transaction;
-- the companion trigger withdraws only effectiveness when trusted evidence
-- is later blocked or deleted. Historical completion facts remain intact.

-- Migration 086 introduced the canonical predicate before functions in this
-- schema consistently pinned their lookup path. Preserve its exact trust
-- contract while qualifying the receipt ledger so security-definer callers
-- can keep a pg_catalog-only search path.
CREATE OR REPLACE FUNCTION public.asset_snapshot_is_trusted_clean(
  p_workspace_id text,
  p_asset_id text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $trusted_clean_asset_hardened$
DECLARE
  source_revision integer;
  storage_key text;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(p_payload->'id') <> 'string'
     OR p_payload->>'id' <> p_asset_id
     OR jsonb_typeof(p_payload->'workspaceId') <> 'string'
     OR p_payload->>'workspaceId' <> p_workspace_id
     OR p_workspace_id = ''
     OR p_workspace_id ~ '[/\\]'
     OR jsonb_typeof(p_payload->'sourceRevision') <> 'number'
     OR p_payload->>'sourceRevision' !~ '^[1-9][0-9]*$'
     OR jsonb_typeof(p_payload->'scanReceiptId') <> 'string'
     OR p_payload->>'scanReceiptId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR jsonb_typeof(p_payload->'scanReceiptDigest') <> 'string'
     OR p_payload->>'scanReceiptDigest' !~ '^[a-f0-9]{64}$'
     OR p_payload->>'scanVerdict' <> 'clean'
     OR jsonb_typeof(p_payload->'storageKey') <> 'string' THEN
    RETURN false;
  END IF;

  IF (p_payload->>'sourceRevision')::numeric > 2147483647 THEN
    RETURN false;
  END IF;

  source_revision := (p_payload->>'sourceRevision')::integer;
  storage_key := p_payload->>'storageKey';
  IF left(storage_key, length('clean/' || p_workspace_id || '/')) <> 'clean/' || p_workspace_id || '/'
     OR length(storage_key) <= length('clean/' || p_workspace_id || '/')
     OR position(E'\\' IN storage_key) <> 0
     OR EXISTS (
       SELECT 1
       FROM unnest(string_to_array(storage_key, '/')) AS segment(value)
       WHERE segment.value IN ('', '.', '..')
     ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.asset_scan_receipts receipt
    WHERE receipt.workspace_id = p_workspace_id
      AND receipt.asset_id = p_asset_id
      AND receipt.asset_source_revision = source_revision
      AND receipt.receipt_id = p_payload->>'scanReceiptId'
      AND receipt.receipt_digest = p_payload->>'scanReceiptDigest'
      AND receipt.verdict = 'clean'
  );
END;
$trusted_clean_asset_hardened$;

CREATE OR REPLACE FUNCTION public.assert_customer_delivery_evidence_asset(
  p_workspace_id text,
  p_delivery_id text,
  p_purpose text,
  p_asset_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $customer_delivery_evidence_asset$
DECLARE
  asset_payload jsonb;
  asset_source_revision integer;
  asset_mime_type text;
  binding_exists boolean;
BEGIN
  IF p_workspace_id IS NULL OR btrim(p_workspace_id) = ''
     OR p_delivery_id IS NULL OR btrim(p_delivery_id) = ''
     OR p_asset_id IS NULL OR btrim(p_asset_id) = ''
     OR p_purpose NOT IN ('contract', 'payment', 'system_integration',
                          'functional_acceptance', 'training', 'video') THEN
    RAISE EXCEPTION 'customer delivery evidence scope is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- SECURITY DEFINER bypasses table RLS, so the session scope is checked
  -- explicitly before any existence probe to avoid cross-tenant disclosure.
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'customer delivery evidence workspace is not authorized'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspace_customer_deliveries delivery
    WHERE delivery.workspace_id = p_workspace_id
      AND delivery.id = p_delivery_id
  ) THEN
    RAISE EXCEPTION 'customer delivery evidence is unavailable'
      USING ERRCODE = '23514';
  END IF;

  -- The row lock closes the application-check/write race: a downgrade or
  -- delete must wait until the transaction that attaches the evidence ends.
  SELECT snapshot.payload
  INTO asset_payload
  FROM public.business_entity_snapshots snapshot
  WHERE snapshot.workspace_id = p_workspace_id
    AND snapshot.entity_type = 'asset'
    AND snapshot.entity_id = p_asset_id
  FOR SHARE;

  IF asset_payload IS NULL
     OR asset_payload->>'scanStatus' <> 'clean'
     OR NOT public.asset_snapshot_is_trusted_clean(
       p_workspace_id,
       p_asset_id,
       asset_payload
     ) THEN
    RAISE EXCEPTION 'customer delivery evidence is unavailable'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(asset_payload->'sourceRevision') <> 'number'
     OR asset_payload->>'sourceRevision' !~ '^[1-9][0-9]*$'
     OR (asset_payload->>'sourceRevision')::numeric > 2147483647
     OR jsonb_typeof(asset_payload->'mimeType') <> 'string' THEN
    RAISE EXCEPTION 'customer delivery evidence is unavailable'
      USING ERRCODE = '23514';
  END IF;
  asset_source_revision := (asset_payload->>'sourceRevision')::integer;
  asset_mime_type := lower(asset_payload->>'mimeType');

  IF (p_purpose = 'video' AND asset_mime_type NOT IN ('video/mp4', 'video/webm'))
     OR (p_purpose <> 'video' AND asset_mime_type NOT IN (
       'application/pdf',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
       'image/png',
       'image/jpeg'
     )) THEN
    RAISE EXCEPTION 'customer delivery evidence is unavailable'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.outbox_events event
    JOIN public.platform_authorization_audit authz
      ON authz.decision_id = event.payload->'delivery_scan_admission'->>'decision_id'
    WHERE event.workspace_id = p_workspace_id
      AND event.aggregate_id = p_asset_id
      AND event.event_type = 'asset.customer_delivery_quarantined'
      AND event.payload->'delivery_scan_admission'->>'workspace_id' = p_workspace_id
      AND event.payload->'delivery_scan_admission'->>'delivery_id' = p_delivery_id
      AND event.payload->'delivery_scan_admission'->>'purpose' = p_purpose
      AND event.payload->'delivery_scan_admission'->>'asset_id' = p_asset_id
      AND event.payload->'delivery_scan_admission'->>'schema_version' = '1'
      AND event.payload->'delivery_scan_admission'->>'operation' = 'customer_delivery.asset.scan.execute'
      AND event.payload->'delivery_scan_admission'->>'workbench' = 'platform'
      AND event.payload->'delivery_scan_admission'->>'context_id' = 'platform:global'
      AND event.payload->'delivery_scan_admission'->>'capability' = 'customer.delivery.update'
      AND event.payload->'delivery_scan_admission'->>'authorized' = 'true'
      AND authz.method = 'ops.customer-delivery.assets.upload'
      AND authz.capability = 'customer.delivery.update'
      AND authz.workbench = 'platform'
      AND authz.result = 'allow'
      AND authz.actor_id = event.payload->'delivery_scan_admission'->>'actor_id'
      AND authz.request_id = event.payload->'delivery_scan_admission'->>'request_id'
      AND authz.trace_id = event.payload->'delivery_scan_admission'->>'trace_id'
      AND event.payload->'delivery_scan_admission'->>'source_revision' ~ '^[1-9][0-9]*$'
      AND (event.payload->'delivery_scan_admission'->>'source_revision')::numeric = asset_source_revision
    UNION ALL
    SELECT 1
    FROM public.outbox_events event
    JOIN public.platform_authorization_audit authz
      ON authz.decision_id = event.payload->>'decision_id'
    WHERE event.workspace_id = p_workspace_id
      AND event.event_type = 'customer_delivery.asset.upload_reused'
      AND event.payload->>'asset_id' = p_asset_id
      AND event.payload->>'delivery_id' = p_delivery_id
      AND event.payload->>'purpose' = p_purpose
      AND event.sequence = asset_source_revision
      AND authz.method = 'ops.customer-delivery.assets.upload'
      AND authz.capability = 'customer.delivery.update'
      AND authz.workbench = 'platform'
      AND authz.result = 'allow'
      AND authz.actor_id = event.payload->>'actor_id'
  ) INTO binding_exists;

  IF NOT binding_exists THEN
    RAISE EXCEPTION 'customer delivery evidence is unavailable'
      USING ERRCODE = '23514';
  END IF;
END;
$customer_delivery_evidence_asset$;

REVOKE ALL ON FUNCTION public.assert_customer_delivery_evidence_asset(text, text, text, text) FROM PUBLIC;

DO $customer_delivery_evidence_asset_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON FUNCTION public.assert_customer_delivery_evidence_asset(text, text, text, text) FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT EXECUTE ON FUNCTION public.assert_customer_delivery_evidence_asset(text, text, text, text) TO merchant_ops;
  END IF;
END
$customer_delivery_evidence_asset_acl$;

CREATE OR REPLACE FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $customer_delivery_evidence_invalidation$
DECLARE
  delivery record;
  invalidation_reason text;
  new_revision bigint;
BEGIN
  IF OLD.entity_type <> 'asset'
     OR OLD.payload->>'scanStatus' <> 'clean'
     OR NOT public.asset_snapshot_is_trusted_clean(
       OLD.workspace_id,
       OLD.entity_id,
       OLD.payload
     ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP <> 'DELETE'
     AND NEW.entity_type = 'asset'
     AND NEW.payload->>'scanStatus' = 'clean'
     AND public.asset_snapshot_is_trusted_clean(
       NEW.workspace_id,
       NEW.entity_id,
       NEW.payload
     ) THEN
    RETURN NULL;
  END IF;

  invalidation_reason := CASE WHEN TG_OP = 'DELETE'
    THEN '可信交付凭证素材已删除，交付生效状态自动失效'
    ELSE '可信交付凭证素材已降级，交付生效状态自动失效'
  END;

  FOR delivery IN
    SELECT candidate.id, candidate.workspace_id, candidate.effective_at,
           candidate.revision
    FROM public.workspace_customer_deliveries candidate
    WHERE candidate.workspace_id = OLD.workspace_id
      AND candidate.effective_at IS NOT NULL
      AND (
        candidate.contract_ref = OLD.entity_id
        OR OLD.entity_id = ANY(candidate.payment_evidence_refs)
        OR OLD.entity_id = ANY(candidate.training_evidence_refs)
        OR EXISTS (
          SELECT 1
          FROM public.workspace_customer_delivery_checklist_items item
          WHERE item.workspace_id = candidate.workspace_id
            AND item.delivery_id = candidate.id
            AND item.evidence->'asset_refs' @> pg_catalog.jsonb_build_array(OLD.entity_id)
        )
        OR EXISTS (
          SELECT 1
          FROM public.workspace_customer_delivery_videos video
          WHERE video.workspace_id = candidate.workspace_id
            AND video.delivery_id = candidate.id
            AND video.asset_ref = OLD.entity_id
            AND video.deleted_at IS NULL
        )
      )
    FOR UPDATE OF candidate
  LOOP
    UPDATE public.workspace_customer_deliveries
    SET effective_at = NULL,
        revision = revision + 1,
        updated_at = pg_catalog.now(),
        updated_by_actor_id = 'system:customer-delivery-evidence-guard'
    WHERE workspace_id = delivery.workspace_id
      AND id = delivery.id
      AND effective_at IS NOT NULL
    RETURNING revision INTO new_revision;

    IF FOUND THEN
      INSERT INTO public.workspace_operation_audit (
        id, workspace_id, actor_id, action, resource_type, resource_id,
        before_json, after_json, reason
      ) VALUES (
        pg_catalog.gen_random_uuid(),
        delivery.workspace_id,
        'system:customer-delivery-evidence-guard',
        'customer_delivery.evidence.invalidated',
        'customer_delivery',
        delivery.id,
        pg_catalog.jsonb_build_object(
          'effective_at', delivery.effective_at,
          'revision', delivery.revision,
          'asset_id', OLD.entity_id,
          'asset_scan_status', OLD.payload->>'scanStatus'
        ),
        pg_catalog.jsonb_build_object(
          'effective_at', NULL,
          'revision', new_revision,
          'asset_id', OLD.entity_id,
          'asset_scan_status', CASE WHEN TG_OP = 'DELETE'
            THEN 'deleted' ELSE NEW.payload->>'scanStatus' END
        ),
        invalidation_reason
      );
    END IF;
  END LOOP;

  RETURN NULL;
END;
$customer_delivery_evidence_invalidation$;

REVOKE ALL ON FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset() FROM PUBLIC;

DROP TRIGGER IF EXISTS business_entity_customer_delivery_evidence_invalidation
  ON public.business_entity_snapshots;
CREATE TRIGGER business_entity_customer_delivery_evidence_invalidation
AFTER UPDATE OF workspace_id, entity_type, entity_id, payload OR DELETE
ON public.business_entity_snapshots
FOR EACH ROW EXECUTE FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset();
