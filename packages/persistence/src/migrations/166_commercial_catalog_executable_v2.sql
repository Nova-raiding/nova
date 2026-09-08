-- 166_commercial_catalog_executable_v2: publish only the rules whose
-- price, permission, period, storage and point semantics are explicit.
-- Historical v1 source rows remain immutable drafts.

WITH seed(id, sku_id, price_fen, price_mode, duration_days, payload) AS (VALUES
  ('sku-version-onboarding-once-v2', 'sku-onboarding-once', 500000::bigint, 'fixed', NULL::integer, '{"policyRef":{"policyId":"commercial.onboarding","version":"v2","permission":"commercial.onboarding.purchase"},"grantSchedule":{"grantCount":6,"pointsPerGrant":500,"cadence":"monthly","startsAt":"payment_verified","timezone":"UTC","grantExpiresAtRule":"next_monthly_anniversary","schedulingStatus":"resolved"},"blockers":[]}'::jsonb),
  ('sku-version-monthly-basic-v2', 'sku-monthly-basic', 200000::bigint, 'fixed', NULL::integer, '{"policyRef":{"policyId":"commercial.plan.basic","version":"v2","permission":"commercial.plan.basic.use"},"maxBrands":1,"maxStores":5,"creativePoints":5000,"storage":{"sourceLabel":"50g","normalizedBytes":50000000000,"normalizationStatus":"resolved","unit":"GB_DECIMAL"},"serviceHours":5,"firstResponseBusinessHours":4,"reviewCadence":"none","billingPeriod":{"cadence":"monthly","startsAt":"payment_verified","timezone":"UTC","endsAt":"next_monthly_anniversary"},"creativePointExpiry":"billing_period_end","blockers":[]}'::jsonb),
  ('sku-version-monthly-growth-v2', 'sku-monthly-growth', 500000::bigint, 'fixed', NULL::integer, '{"policyRef":{"policyId":"commercial.plan.growth","version":"v2","permission":"commercial.plan.growth.use"},"maxBrands":3,"maxStores":15,"creativePoints":12500,"storage":{"sourceLabel":"50g","normalizedBytes":50000000000,"normalizationStatus":"resolved","unit":"GB_DECIMAL"},"serviceHours":10,"firstResponseBusinessHours":2,"reviewCadence":"monthly","billingPeriod":{"cadence":"monthly","startsAt":"payment_verified","timezone":"UTC","endsAt":"next_monthly_anniversary"},"creativePointExpiry":"billing_period_end","blockers":[]}'::jsonb),
  ('sku-version-monthly-custom-v2', 'sku-monthly-custom', NULL::bigint, 'starts_at', NULL::integer, '{"policyRef":{"policyId":"commercial.plan.custom","version":"v2","permission":"commercial.plan.custom.contract"},"minimumMonthlyPriceCny":10000,"storage":{"sourceLabel":"50g","normalizedBytes":50000000000,"normalizationStatus":"resolved","unit":"GB_DECIMAL"},"blockers":["ORDER_TERMS_REQUIRED"]}'::jsonb),
  ('sku-version-points-500-v2', 'sku-points-500', 30000::bigint, 'fixed', NULL::integer, '{"policyRef":{"policyId":"commercial.points.pack.500","version":"v2","permission":"commercial.points.pack.purchase"},"creativePoints":500,"expiryRule":"purchase_plus_30_natural_days","expiryDays":30,"blockers":[]}'::jsonb),
  ('sku-version-points-2000-v2', 'sku-points-2000', 100000::bigint, 'fixed', NULL::integer, '{"policyRef":{"policyId":"commercial.points.pack.2000","version":"v2","permission":"commercial.points.pack.purchase"},"creativePoints":2000,"expiryRule":"purchase_plus_30_natural_days","expiryDays":30,"blockers":[]}'::jsonb),
  ('sku-version-private-validation-7d-v2', 'sku-private-validation-7d', 199900::bigint, 'fixed', 7, '{"policyRef":{"policyId":"commercial.private_validation","version":"v1","permission":"commercial.private_sku.read"},"maxBrands":1,"maxStores":1,"creativePoints":500,"oneToOneServiceHours":1,"outcomeReviewCount":1,"blockers":["PRIVATE_OFFER_ELIGIBILITY_UNRESOLVED","PRIVATE_OFFSET_ACCOUNTING_UNRESOLVED"]}'::jsonb)
)
INSERT INTO commercial_catalog_sku_versions
  (id, sku_id, version, lifecycle, executable, price_fen, currency, price_mode, duration_days, payload, checksum, effective_at)
SELECT id, sku_id, 2, CASE WHEN jsonb_array_length(payload->'blockers') = 0 THEN 'approved' ELSE 'draft' END,
  jsonb_array_length(payload->'blockers') = 0, price_fen, CASE WHEN price_fen IS NULL THEN NULL ELSE 'CNY' END,
  price_mode, duration_days, payload, encode(sha256(convert_to(payload::text, 'UTF8')), 'hex'),
  CASE WHEN jsonb_array_length(payload->'blockers') = 0 THEN now() ELSE NULL END
FROM seed;

INSERT INTO commercial_catalog_sku_benefits (id, sku_version_id, benefit_code, quantity, raw_value, raw_unit, normalized_value, policy_ref, metadata) VALUES
  ('benefit-onboarding-grant-count-v2','sku-version-onboarding-once-v2','grant_count',6,NULL,'monthly_grants',NULL,'commercial.onboarding.v2','{"permission":"commercial.onboarding.purchase"}'),
  ('benefit-onboarding-points-per-grant-v2','sku-version-onboarding-once-v2','points_per_grant',500,NULL,'creative_points',NULL,'commercial.onboarding.v2','{}'),
  ('benefit-basic-brands-v2','sku-version-monthly-basic-v2','max_brands',1,NULL,'brand',NULL,'commercial.plan.basic.v2','{}'),
  ('benefit-basic-stores-v2','sku-version-monthly-basic-v2','max_stores',5,NULL,'store',NULL,'commercial.plan.basic.v2','{}'),
  ('benefit-basic-points-v2','sku-version-monthly-basic-v2','monthly_creative_points',5000,NULL,'creative_points',NULL,'commercial.plan.basic.v2','{"expires":"billing_period_end"}'),
  ('benefit-basic-storage-v2','sku-version-monthly-basic-v2','cloud_storage',50,'50g','GB_DECIMAL',50000000000,'commercial.plan.basic.v2','{}'),
  ('benefit-basic-service-v2','sku-version-monthly-basic-v2','monthly_one_to_one_hours',5,NULL,'hour',NULL,'commercial.plan.basic.v2','{}'),
  ('benefit-basic-response-v2','sku-version-monthly-basic-v2','first_response_business_hours',4,NULL,'business_hour',NULL,'commercial.plan.basic.v2','{}'),
  ('benefit-growth-brands-v2','sku-version-monthly-growth-v2','max_brands',3,NULL,'brand',NULL,'commercial.plan.growth.v2','{}'),
  ('benefit-growth-stores-v2','sku-version-monthly-growth-v2','max_stores',15,NULL,'store',NULL,'commercial.plan.growth.v2','{}'),
  ('benefit-growth-points-v2','sku-version-monthly-growth-v2','monthly_creative_points',12500,NULL,'creative_points',NULL,'commercial.plan.growth.v2','{"expires":"billing_period_end"}'),
  ('benefit-growth-storage-v2','sku-version-monthly-growth-v2','cloud_storage',50,'50g','GB_DECIMAL',50000000000,'commercial.plan.growth.v2','{}'),
  ('benefit-growth-service-v2','sku-version-monthly-growth-v2','monthly_one_to_one_hours',10,NULL,'hour',NULL,'commercial.plan.growth.v2','{}'),
  ('benefit-growth-response-v2','sku-version-monthly-growth-v2','first_response_business_hours',2,NULL,'business_hour',NULL,'commercial.plan.growth.v2','{}'),
  ('benefit-pack-500-v2','sku-version-points-500-v2','creative_points',500,NULL,'creative_points',NULL,'commercial.points.pack.500.v2','{"expires":"purchase_plus_30_natural_days"}'),
  ('benefit-pack-2000-v2','sku-version-points-2000-v2','creative_points',2000,NULL,'creative_points',NULL,'commercial.points.pack.2000.v2','{"expires":"purchase_plus_30_natural_days"}'),
  ('benefit-private-brands-v2','sku-version-private-validation-7d-v2','max_brands',1,NULL,'brand',NULL,'commercial.private_validation.v1','{}'),
  ('benefit-private-stores-v2','sku-version-private-validation-7d-v2','max_stores',1,NULL,'store',NULL,'commercial.private_validation.v1','{}'),
  ('benefit-private-points-v2','sku-version-private-validation-7d-v2','creative_points',500,NULL,'creative_points',NULL,'commercial.private_validation.v1','{}');

INSERT INTO creative_point_rate_card_versions_v2 (id, version, lifecycle, executable, approval_status, checksum, effective_at)
VALUES ('rate-card-approved-v2', 2, 'approved', true, 'approved', encode(sha256(convert_to('commercial.points.rate-card.v2', 'UTF8')), 'hex'), now());

INSERT INTO creative_point_rate_rules_v2 (id, rate_card_version_id, action_code, unit, integer_points, pricing_mode, variable_formula, executable, blockers) VALUES
  ('rate-image-generate-standard-v2','rate-card-approved-v2','image.generate.standard','image',1,'fixed',NULL,true,'[]'::jsonb),
  ('rate-image-edit-annotation-v2','rate-card-approved-v2','image.edit.annotation','image',1,'fixed',NULL,true,'[]'::jsonb),
  ('rate-video-standard-15s-v2','rate-card-approved-v2','video.generate.standard_15s','video',90,'fixed',NULL,true,'[]'::jsonb),
  ('rate-text-generate-v2','rate-card-approved-v2','text.generate','request',1,'fixed',NULL,true,'[]'::jsonb);

INSERT INTO commercial_catalog_events_v2 (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision)
SELECT 'catalog-event-' || id, 'sku_version', id, CASE WHEN executable THEN 'published' ELSE 'source_imported' END,
  'migration:166', 'Published executable commercial policy v2 with one-to-one price, permission, period and point bindings',
  jsonb_build_object('source_document','商业化方案 (1).md','policy_version',2,'blockers',payload->'blockers'), 1
FROM commercial_catalog_sku_versions WHERE version=2;

INSERT INTO commercial_catalog_events_v2 (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision)
VALUES ('catalog-event-rate-card-approved-v2','rate_card_version','rate-card-approved-v2','published','migration:166','Published fixed creative-point consumption rates','{"source_document":"商业化方案 (1).md","rates":{"image":1,"edit":1,"video_15s":90,"text_request":1}}'::jsonb,1);
