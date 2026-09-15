-- Bind delivery evidence to the exact content identity recorded by its signed
-- scan receipt. This is forward-only: migrations 204-206 may already be
-- applied and their checksums must remain immutable.
CREATE OR REPLACE FUNCTION public.asset_snapshot_is_trusted_clean(
  p_workspace_id text,
  p_asset_id text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $trusted_clean_asset_receipt_identity$
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
     OR jsonb_typeof(p_payload->'storageKey') <> 'string'
     OR jsonb_typeof(p_payload->'mimeType') <> 'string'
     OR p_payload->>'mimeType' = ''
     OR jsonb_typeof(p_payload->'sha256') <> 'string'
     OR p_payload->>'sha256' !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(p_payload->'sizeBytes') <> 'number'
     OR p_payload->>'sizeBytes' !~ '^[1-9][0-9]*$' THEN
    RETURN false;
  END IF;

  IF (p_payload->>'sourceRevision')::numeric > 2147483647
     OR (p_payload->>'sizeBytes')::numeric > 9223372036854775807 THEN
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
      AND receipt.receipt->'subject'->>'mime_type' = p_payload->>'mimeType'
      AND receipt.receipt->'subject'->>'sha256' = p_payload->>'sha256'
      AND receipt.receipt->'subject'->>'size_bytes' = p_payload->>'sizeBytes'
  );
END;
$trusted_clean_asset_receipt_identity$;

-- Rows accepted by the earlier predicate may already carry mutable identity
-- fields that disagree with their immutable receipt. Capture them before
-- downgrading so every effective delivery is withdrawn and audited once.
CREATE TEMP TABLE customer_delivery_evidence_identity_mismatch_207
ON COMMIT DROP
AS
SELECT snapshot.workspace_id, snapshot.entity_id
FROM public.business_entity_snapshots snapshot
WHERE snapshot.entity_type = 'asset'
  AND snapshot.payload->>'scanStatus' = 'clean'
  AND NOT public.asset_snapshot_is_trusted_clean(
    snapshot.workspace_id,
    snapshot.entity_id,
    snapshot.payload
  );

CREATE OR REPLACE FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $customer_delivery_evidence_receipt_identity_invalidation$
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
     AND NEW.workspace_id = OLD.workspace_id
     AND NEW.entity_id = OLD.entity_id
     AND NEW.payload->>'scanStatus' = 'clean'
     AND ROW(
       NEW.payload->>'sourceRevision',
       NEW.payload->>'scanReceiptId',
       NEW.payload->>'scanReceiptDigest',
       NEW.payload->>'storageKey',
       NEW.payload->>'mimeType',
       NEW.payload->>'sha256',
       NEW.payload->>'sizeBytes',
       NEW.payload->>'scanStatus',
       NEW.payload->>'scanVerdict'
     ) IS NOT DISTINCT FROM ROW(
       OLD.payload->>'sourceRevision',
       OLD.payload->>'scanReceiptId',
       OLD.payload->>'scanReceiptDigest',
       OLD.payload->>'storageKey',
       OLD.payload->>'mimeType',
       OLD.payload->>'sha256',
       OLD.payload->>'sizeBytes',
       OLD.payload->>'scanStatus',
       OLD.payload->>'scanVerdict'
     )
     AND public.asset_snapshot_is_trusted_clean(
       NEW.workspace_id,
       NEW.entity_id,
       NEW.payload
     ) THEN
    RETURN NULL;
  END IF;

  invalidation_reason := CASE WHEN TG_OP = 'DELETE'
    THEN '可信交付凭证素材已删除，交付生效状态自动失效'
    ELSE '可信交付凭证素材证据身份已变化或降级，交付生效状态自动失效'
  END;

  FOR delivery IN
    SELECT candidate.id, candidate.workspace_id, candidate.effective_at,
           candidate.revision
    FROM public.workspace_customer_deliveries candidate
    WHERE candidate.workspace_id = OLD.workspace_id
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
    ORDER BY candidate.id
    FOR UPDATE OF candidate NOWAIT
  LOOP
    UPDATE public.workspace_customer_deliveries
    SET effective_at = NULL,
        revision = revision + 1,
        updated_at = pg_catalog.now(),
        updated_by_actor_id = 'system:customer-delivery-evidence-guard'
    WHERE workspace_id = delivery.workspace_id
      AND id = delivery.id
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
$customer_delivery_evidence_receipt_identity_invalidation$;

REVOKE ALL ON FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset() FROM PUBLIC;

DO $customer_delivery_receipt_identity_backfill$
DECLARE
  delivery record;
  new_revision bigint;
BEGIN
  FOR delivery IN
    SELECT candidate.id, candidate.workspace_id, candidate.effective_at,
           candidate.revision,
           ARRAY(
             SELECT mismatch.entity_id
             FROM pg_temp.customer_delivery_evidence_identity_mismatch_207 mismatch
             WHERE mismatch.workspace_id = candidate.workspace_id
               AND (
                 candidate.contract_ref = mismatch.entity_id
                 OR mismatch.entity_id = ANY(candidate.payment_evidence_refs)
                 OR mismatch.entity_id = ANY(candidate.training_evidence_refs)
                 OR EXISTS (
                   SELECT 1
                   FROM public.workspace_customer_delivery_checklist_items item
                   WHERE item.workspace_id = candidate.workspace_id
                     AND item.delivery_id = candidate.id
                     AND item.evidence->'asset_refs' @> pg_catalog.jsonb_build_array(mismatch.entity_id)
                 )
                 OR EXISTS (
                   SELECT 1
                   FROM public.workspace_customer_delivery_videos video
                   WHERE video.workspace_id = candidate.workspace_id
                     AND video.delivery_id = candidate.id
                     AND video.asset_ref = mismatch.entity_id
                     AND video.deleted_at IS NULL
                 )
               )
             ORDER BY mismatch.entity_id
           ) AS asset_ids
    FROM public.workspace_customer_deliveries candidate
    WHERE candidate.effective_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM pg_temp.customer_delivery_evidence_identity_mismatch_207 mismatch
        WHERE mismatch.workspace_id = candidate.workspace_id
          AND (
            candidate.contract_ref = mismatch.entity_id
            OR mismatch.entity_id = ANY(candidate.payment_evidence_refs)
            OR mismatch.entity_id = ANY(candidate.training_evidence_refs)
            OR EXISTS (
              SELECT 1
              FROM public.workspace_customer_delivery_checklist_items item
              WHERE item.workspace_id = candidate.workspace_id
                AND item.delivery_id = candidate.id
                AND item.evidence->'asset_refs' @> pg_catalog.jsonb_build_array(mismatch.entity_id)
            )
            OR EXISTS (
              SELECT 1
              FROM public.workspace_customer_delivery_videos video
              WHERE video.workspace_id = candidate.workspace_id
                AND video.delivery_id = candidate.id
                AND video.asset_ref = mismatch.entity_id
                AND video.deleted_at IS NULL
            )
          )
      )
    ORDER BY candidate.id
    FOR UPDATE OF candidate NOWAIT
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
          'asset_ids', pg_catalog.to_jsonb(delivery.asset_ids)
        ),
        pg_catalog.jsonb_build_object(
          'effective_at', NULL,
          'revision', new_revision,
          'asset_ids', pg_catalog.to_jsonb(delivery.asset_ids),
          'asset_scan_status', 'blocked'
        ),
        '可信交付凭证的 MIME、哈希或字节数与扫描回执不一致，交付生效状态自动失效'
      );
    END IF;
  END LOOP;
END;
$customer_delivery_receipt_identity_backfill$;

UPDATE public.business_entity_snapshots snapshot
SET payload = pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(snapshot.payload, '{scanStatus}', '"blocked"'::jsonb, true),
      '{revision}',
      pg_catalog.to_jsonb(snapshot.entity_version + 1),
      true
    ),
    entity_version = snapshot.entity_version + 1,
    updated_at = pg_catalog.now()
FROM pg_temp.customer_delivery_evidence_identity_mismatch_207 mismatch
WHERE snapshot.workspace_id = mismatch.workspace_id
  AND snapshot.entity_type = 'asset'
  AND snapshot.entity_id = mismatch.entity_id;
