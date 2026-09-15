-- Forward-only concurrency repair for the evidence invalidation trigger.
-- Delivery writers lock the delivery row before validating referenced assets,
-- while this trigger already holds the changed asset row. Lock deliveries in a
-- deterministic order and fail fast on a conflicting writer so the asset
-- mutation can be retried without forming a lock-order cycle. Never skip a
-- locked delivery: every reference to degraded evidence must be invalidated.
CREATE OR REPLACE FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $customer_delivery_evidence_invalidation_lock_order$
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
       NEW.payload->>'scanStatus',
       NEW.payload->>'scanVerdict'
     ) IS NOT DISTINCT FROM ROW(
       OLD.payload->>'sourceRevision',
       OLD.payload->>'scanReceiptId',
       OLD.payload->>'scanReceiptDigest',
       OLD.payload->>'storageKey',
       OLD.payload->>'mimeType',
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
$customer_delivery_evidence_invalidation_lock_order$;

REVOKE ALL ON FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset() FROM PUBLIC;
