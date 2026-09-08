-- 174_private_trial_entitlement_activation: publish a new immutable catalog
-- version for the invited 1999 CNY validation offer. The original v2 source
-- row remains immutable; public purchase still requires the private workflow.

WITH private_trial_v3(payload) AS (VALUES ('{"policyRef":{"policyId":"commercial.private_validation","version":"v1","permission":"commercial.private_sku.read"},"maxBrands":1,"maxStores":1,"creativePoints":500,"oneToOneServiceHours":1,"outcomeReviewCount":1,"blockers":[]}'::jsonb))
INSERT INTO commercial_catalog_sku_versions
  (id, sku_id, version, lifecycle, executable, price_fen, currency, price_mode, duration_days, payload, checksum, effective_at)
SELECT 'sku-version-private-validation-7d-v3', 'sku-private-validation-7d', 3, 'approved', true, 199900, 'CNY', 'fixed', 7,
       payload, encode(sha256(convert_to(payload::text, 'UTF8')), 'hex'), now()
  FROM private_trial_v3
ON CONFLICT (id) DO NOTHING;

INSERT INTO commercial_catalog_sku_benefits
  (id, sku_version_id, benefit_code, quantity, raw_value, raw_unit, normalized_value, policy_ref, metadata)
VALUES
  ('benefit-private-service-hours-v3','sku-version-private-validation-7d-v3','one_to_one_service_hours',1,NULL,'hour',NULL,'commercial.private_validation.v1','{}'),
  ('benefit-private-review-v3','sku-version-private-validation-7d-v3','outcome_review_count',1,NULL,'review',NULL,'commercial.private_validation.v1','{}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO commercial_catalog_events_v2
  (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision)
VALUES
  ('catalog-event-private-validation-7d-v3-activated','sku_version','sku-version-private-validation-7d-v3','published',
   'migration:174','Activated invited private trial entitlement policy after eligibility workflow implementation',
   '{"source_document":"commercial-executable-spec.md","private":true,"grant":{"max_brands":1,"max_stores":1,"creative_points":500,"duration_days":7}}'::jsonb,2)
ON CONFLICT (id) DO NOTHING;
