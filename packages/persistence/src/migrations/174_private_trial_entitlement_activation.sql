-- 174_private_trial_entitlement_activation: make the invited 1999 CNY
-- validation offer executable only through the private eligibility workflow.
-- Public catalog exposure remains blocked by visibility=private and the
-- required commercial.private_sku.read capability.

UPDATE commercial_catalog_sku_versions
   SET lifecycle='approved', executable=true, effective_at=COALESCE(effective_at, now()),
       payload = jsonb_set(payload, '{blockers}', '[]'::jsonb, true),
       checksum = encode(sha256(convert_to(jsonb_set(payload, '{blockers}', '[]'::jsonb, true)::text, 'UTF8')), 'hex')
 WHERE id='sku-version-private-validation-7d-v2'
   AND lifecycle='draft' AND executable=false;

INSERT INTO commercial_catalog_sku_benefits
  (id, sku_version_id, benefit_code, quantity, raw_value, raw_unit, normalized_value, policy_ref, metadata)
VALUES
  ('benefit-private-service-hours-v2','sku-version-private-validation-7d-v2','one_to_one_service_hours',1,NULL,'hour',NULL,'commercial.private_validation.v1','{}'),
  ('benefit-private-review-v2','sku-version-private-validation-7d-v2','outcome_review_count',1,NULL,'review',NULL,'commercial.private_validation.v1','{}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO commercial_catalog_events_v2
  (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision)
VALUES
  ('catalog-event-private-validation-7d-v2-activated','sku_version','sku-version-private-validation-7d-v2','published',
   'migration:174','Activated invited private trial entitlement policy after eligibility workflow implementation',
   '{"source_document":"commercial-executable-spec.md","private":true,"grant":{"max_brands":1,"max_stores":1,"creative_points":500,"duration_days":7}}'::jsonb,2)
ON CONFLICT (id) DO NOTHING;
