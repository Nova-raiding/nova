-- 146_commercial_catalog_v2: immutable, versioned global commercial catalog.
-- Every source value seeded here remains draft/pending and non-executable.
-- This migration intentionally creates no order, payment, subscription, or
-- creative-point grant state.

CREATE TABLE commercial_catalog_skus (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('onboarding', 'monthly', 'point_pack', 'private_trial')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  required_capability TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((visibility = 'private' AND required_capability IS NOT NULL)
      OR (visibility = 'public' AND required_capability IS NULL))
);

CREATE TABLE commercial_catalog_sku_versions (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL REFERENCES commercial_catalog_skus(id),
  version INTEGER NOT NULL CHECK (version > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'pending_business_approval', 'approved', 'retired')),
  executable BOOLEAN NOT NULL DEFAULT false,
  price_fen BIGINT CHECK (price_fen IS NULL OR price_fen >= 0),
  currency TEXT CHECK (currency IS NULL OR currency = 'CNY'),
  price_mode TEXT NOT NULL CHECK (price_mode IN ('fixed', 'starts_at', 'custom')),
  duration_days INTEGER CHECK (duration_days IS NULL OR duration_days > 0),
  payload JSONB NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  effective_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sku_id, version),
  UNIQUE (id, sku_id),
  CHECK (price_fen IS NULL OR currency IS NOT NULL),
  CHECK (NOT executable OR (lifecycle = 'approved' AND effective_at IS NOT NULL))
);

CREATE TABLE commercial_catalog_sku_benefits (
  id TEXT PRIMARY KEY,
  sku_version_id TEXT NOT NULL REFERENCES commercial_catalog_sku_versions(id),
  benefit_code TEXT NOT NULL,
  quantity BIGINT,
  raw_value TEXT,
  raw_unit TEXT,
  normalized_value BIGINT,
  policy_ref TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sku_version_id, benefit_code),
  CHECK (quantity IS NULL OR quantity >= 0),
  CHECK (normalized_value IS NULL OR normalized_value >= 0)
);

CREATE TABLE creative_point_rate_card_versions_v2 (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK (version > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'pending_business_approval', 'approved', 'retired')),
  executable BOOLEAN NOT NULL DEFAULT false,
  approval_status TEXT NOT NULL CHECK (approval_status IN ('pending_business_approval', 'approved', 'rejected')),
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  effective_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT executable OR (lifecycle = 'approved' AND approval_status = 'approved' AND effective_at IS NOT NULL))
);

CREATE TABLE creative_point_rate_rules_v2 (
  id TEXT PRIMARY KEY,
  rate_card_version_id TEXT NOT NULL REFERENCES creative_point_rate_card_versions_v2(id),
  action_code TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('image', 'video', 'request')),
  integer_points BIGINT CHECK (integer_points IS NULL OR integer_points > 0),
  pricing_mode TEXT NOT NULL CHECK (pricing_mode IN ('fixed', 'starts_at', 'unresolved')),
  variable_formula JSONB,
  executable BOOLEAN NOT NULL DEFAULT false,
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rate_card_version_id, action_code),
  CHECK (NOT executable OR (pricing_mode = 'fixed' AND integer_points IS NOT NULL))
);

CREATE TABLE commercial_catalog_events_v2 (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('sku_version', 'rate_card_version')),
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('source_imported', 'submitted', 'approved', 'published', 'retired')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (aggregate_type, aggregate_id, revision)
);

CREATE INDEX commercial_catalog_versions_resolve_idx
  ON commercial_catalog_sku_versions(sku_id, lifecycle, executable, effective_at DESC, version DESC);
CREATE INDEX creative_point_rates_resolve_idx
  ON creative_point_rate_rules_v2(action_code, rate_card_version_id);

CREATE OR REPLACE FUNCTION reject_commercial_catalog_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commercial catalog facts are immutable' USING ERRCODE = '55000';
END;
$$;

DO $commercial_catalog_immutable$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commercial_catalog_skus',
    'commercial_catalog_sku_versions',
    'commercial_catalog_sku_benefits',
    'creative_point_rate_card_versions_v2',
    'creative_point_rate_rules_v2',
    'commercial_catalog_events_v2'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_commercial_catalog_fact_mutation()', table_name || '_immutable', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_catalog_fact_mutation()', table_name || '_no_truncate', table_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM PUBLIC', table_name);
  END LOOP;
END
$commercial_catalog_immutable$;

DO $commercial_catalog_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    -- Merchant runtime must consume a capability-trimmed application response;
    -- it never receives direct access to global catalog base tables.
    REVOKE ALL ON commercial_catalog_skus,
      commercial_catalog_sku_versions, commercial_catalog_sku_benefits,
      creative_point_rate_card_versions_v2, creative_point_rate_rules_v2,
      commercial_catalog_events_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON commercial_catalog_skus, commercial_catalog_sku_versions,
      commercial_catalog_sku_benefits, creative_point_rate_card_versions_v2,
      creative_point_rate_rules_v2, commercial_catalog_events_v2 TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_catalog_skus,
      commercial_catalog_sku_versions, commercial_catalog_sku_benefits,
      creative_point_rate_card_versions_v2, creative_point_rate_rules_v2,
      commercial_catalog_events_v2 FROM merchant_ops;
  END IF;
END
$commercial_catalog_acl$;

INSERT INTO commercial_catalog_skus (id, code, kind, visibility, required_capability) VALUES
  ('sku-onboarding-once', 'onboarding_once', 'onboarding', 'public', NULL),
  ('sku-monthly-basic', 'basic', 'monthly', 'public', NULL),
  ('sku-monthly-growth', 'growth', 'monthly', 'public', NULL),
  ('sku-monthly-custom', 'custom', 'monthly', 'public', NULL),
  ('sku-points-500', 'points_500', 'point_pack', 'public', NULL),
  ('sku-points-2000', 'points_2000', 'point_pack', 'public', NULL),
  ('sku-private-validation-7d', 'private_validation_7d', 'private_trial', 'private', 'commercial.private_sku.read');

WITH seed(id, sku_id, price_fen, price_mode, duration_days, payload) AS (VALUES
  ('sku-version-onboarding-once-v1', 'sku-onboarding-once', 500000::BIGINT, 'fixed', NULL::INTEGER,
    '{"grantSchedule":{"grantCount":6,"pointsPerGrant":500,"cadence":"monthly","startsAt":null,"grantExpiresAtRule":null,"schedulingStatus":"unresolved"},"blockers":["ONBOARDING_GRANT_SCHEDULE_UNRESOLVED"]}'::jsonb),
  ('sku-version-monthly-basic-v1', 'sku-monthly-basic', 200000::BIGINT, 'fixed', NULL::INTEGER,
    '{"maxBrands":1,"maxStores":5,"creativePoints":5000,"storage":{"sourceLabel":"50g","normalizedBytes":null,"normalizationStatus":"unit_unresolved"},"serviceHours":5,"firstResponseBusinessHours":4,"reviewCadence":"none","blockers":["STORAGE_UNIT_UNRESOLVED"]}'::jsonb),
  ('sku-version-monthly-growth-v1', 'sku-monthly-growth', 500000::BIGINT, 'fixed', NULL::INTEGER,
    '{"maxBrands":3,"maxStores":15,"creativePoints":12500,"storage":{"sourceLabel":"50g","normalizedBytes":null,"normalizationStatus":"unit_unresolved"},"serviceHours":10,"firstResponseBusinessHours":2,"reviewCadence":"monthly","blockers":["STORAGE_UNIT_UNRESOLVED"]}'::jsonb),
  ('sku-version-monthly-custom-v1', 'sku-monthly-custom', 1000000::BIGINT, 'starts_at', NULL::INTEGER,
    '{"maxBrands":null,"maxStores":null,"creativePoints":null,"storage":{"sourceLabel":"50g","normalizedBytes":null,"normalizationStatus":"unit_unresolved"},"serviceHours":null,"firstResponseBusinessHours":null,"reviewCadence":"weekly_or_monthly","blockers":["ORDER_TERMS_REQUIRED","STORAGE_UNIT_UNRESOLVED"]}'::jsonb),
  ('sku-version-points-500-v1', 'sku-points-500', 30000::BIGINT, 'fixed', NULL::INTEGER,
    '{"creativePoints":500,"expiryRule":null,"blockers":["CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED","BUSINESS_APPROVAL_REQUIRED"]}'::jsonb),
  ('sku-version-points-2000-v1', 'sku-points-2000', 100000::BIGINT, 'fixed', NULL::INTEGER,
    '{"creativePoints":2000,"expiryRule":null,"blockers":["CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED","BUSINESS_APPROVAL_REQUIRED"]}'::jsonb),
  ('sku-version-private-validation-7d-v1', 'sku-private-validation-7d', 199900::BIGINT, 'fixed', 7,
    '{"maxBrands":1,"maxStores":1,"creativePoints":500,"oneToOneServiceHours":1,"coreExperienceIncluded":true,"outcomeReviewCount":1,"onboardingOffset":{"targetOfferCode":"onboarding_once","amountCny":5000,"eligibilityWindowDaysAfterValidation":7,"eligibilityAndAccountingStatus":"unresolved"},"blockers":["PRIVATE_OFFER_ELIGIBILITY_UNRESOLVED","PRIVATE_OFFSET_ACCOUNTING_UNRESOLVED"]}'::jsonb)
)
INSERT INTO commercial_catalog_sku_versions
  (id, sku_id, version, lifecycle, executable, price_fen, currency, price_mode, duration_days, payload, checksum, effective_at)
SELECT id, sku_id, 1, 'draft', false, price_fen, 'CNY', price_mode, duration_days,
  payload, encode(sha256(convert_to(payload::text, 'UTF8')), 'hex'), NULL
FROM seed;

INSERT INTO commercial_catalog_sku_benefits
  (id, sku_version_id, benefit_code, quantity, raw_value, raw_unit, normalized_value, policy_ref, metadata) VALUES
  ('benefit-onboarding-grant-count', 'sku-version-onboarding-once-v1', 'grant_count', 6, NULL, 'monthly_grants', NULL, 'ONBOARDING_GRANT_SCHEDULE_UNRESOLVED', '{}'::jsonb),
  ('benefit-onboarding-points-per-grant', 'sku-version-onboarding-once-v1', 'points_per_grant', 500, NULL, 'creative_points', NULL, 'ONBOARDING_GRANT_SCHEDULE_UNRESOLVED', '{}'::jsonb),
  ('benefit-basic-brands', 'sku-version-monthly-basic-v1', 'max_brands', 1, NULL, 'brand', NULL, NULL, '{}'::jsonb),
  ('benefit-basic-stores', 'sku-version-monthly-basic-v1', 'max_stores', 5, NULL, 'store', NULL, NULL, '{}'::jsonb),
  ('benefit-basic-points', 'sku-version-monthly-basic-v1', 'monthly_creative_points', 5000, NULL, 'creative_points', NULL, NULL, '{}'::jsonb),
  ('benefit-basic-storage', 'sku-version-monthly-basic-v1', 'cloud_storage', 50, '50g', 'g', NULL, 'STORAGE_UNIT_UNRESOLVED', '{}'::jsonb),
  ('benefit-basic-service', 'sku-version-monthly-basic-v1', 'monthly_one_to_one_hours', 5, NULL, 'hour', NULL, NULL, '{}'::jsonb),
  ('benefit-basic-response', 'sku-version-monthly-basic-v1', 'first_response_business_hours', 4, NULL, 'business_hour', NULL, NULL, '{}'::jsonb),
  ('benefit-growth-brands', 'sku-version-monthly-growth-v1', 'max_brands', 3, NULL, 'brand', NULL, NULL, '{}'::jsonb),
  ('benefit-growth-stores', 'sku-version-monthly-growth-v1', 'max_stores', 15, NULL, 'store', NULL, NULL, '{}'::jsonb),
  ('benefit-growth-points', 'sku-version-monthly-growth-v1', 'monthly_creative_points', 12500, NULL, 'creative_points', NULL, NULL, '{}'::jsonb),
  ('benefit-growth-storage', 'sku-version-monthly-growth-v1', 'cloud_storage', 50, '50g', 'g', NULL, 'STORAGE_UNIT_UNRESOLVED', '{}'::jsonb),
  ('benefit-growth-service', 'sku-version-monthly-growth-v1', 'monthly_one_to_one_hours', 10, NULL, 'hour', NULL, NULL, '{}'::jsonb),
  ('benefit-growth-response', 'sku-version-monthly-growth-v1', 'first_response_business_hours', 2, NULL, 'business_hour', NULL, NULL, '{}'::jsonb),
  ('benefit-custom-storage', 'sku-version-monthly-custom-v1', 'cloud_storage', 50, '50g', 'g', NULL, 'STORAGE_UNIT_UNRESOLVED', '{}'::jsonb),
  ('benefit-pack-500', 'sku-version-points-500-v1', 'creative_points', 500, NULL, 'creative_points', NULL, 'CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED', '{}'::jsonb),
  ('benefit-pack-2000', 'sku-version-points-2000-v1', 'creative_points', 2000, NULL, 'creative_points', NULL, 'CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED', '{}'::jsonb),
  ('benefit-private-brands', 'sku-version-private-validation-7d-v1', 'max_brands', 1, NULL, 'brand', NULL, NULL, '{}'::jsonb),
  ('benefit-private-stores', 'sku-version-private-validation-7d-v1', 'max_stores', 1, NULL, 'store', NULL, NULL, '{}'::jsonb),
  ('benefit-private-points', 'sku-version-private-validation-7d-v1', 'creative_points', 500, NULL, 'creative_points', NULL, NULL, '{}'::jsonb),
  ('benefit-private-service', 'sku-version-private-validation-7d-v1', 'one_to_one_service_hours', 1, NULL, 'hour', NULL, NULL, '{}'::jsonb),
  ('benefit-private-review', 'sku-version-private-validation-7d-v1', 'outcome_review_count', 1, NULL, 'review', NULL, NULL, '{}'::jsonb);

INSERT INTO creative_point_rate_card_versions_v2
  (id, version, lifecycle, executable, approval_status, checksum, effective_at)
VALUES ('rate-card-source-draft-v1', 1, 'pending_business_approval', false,
  'pending_business_approval', encode(sha256(convert_to('commercialization-source-rate-card-v1', 'UTF8')), 'hex'), NULL);

INSERT INTO creative_point_rate_rules_v2
  (id, rate_card_version_id, action_code, unit, integer_points, pricing_mode, variable_formula, executable, blockers) VALUES
  ('rate-image-generate-standard-v1', 'rate-card-source-draft-v1', 'image.generate.standard', 'image', 1, 'fixed', NULL, false, '["BUSINESS_APPROVAL_REQUIRED"]'::jsonb),
  ('rate-image-edit-annotation-v1', 'rate-card-source-draft-v1', 'image.edit.annotation', 'image', 1, 'fixed', NULL, false, '["BUSINESS_APPROVAL_REQUIRED"]'::jsonb),
  ('rate-video-standard-15s-v1', 'rate-card-source-draft-v1', 'video.generate.standard_15s', 'video', 90, 'starts_at', NULL, false, '["VIDEO_RATE_FORMULA_UNRESOLVED","BUSINESS_APPROVAL_REQUIRED"]'::jsonb),
  ('rate-text-generate-v1', 'rate-card-source-draft-v1', 'text.generate', 'request', NULL, 'unresolved', NULL, false, '["TEXT_RATE_UNRESOLVED","BUSINESS_APPROVAL_REQUIRED"]'::jsonb);

INSERT INTO commercial_catalog_events_v2
  (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision)
SELECT 'catalog-event-' || id, 'sku_version', id, 'source_imported',
  'migration:146', 'Imported verbatim commercial source values as non-executable draft',
  jsonb_build_object('source_document', '商业化方案.md', 'lifecycle', 'draft'), 1
FROM commercial_catalog_sku_versions;

INSERT INTO commercial_catalog_events_v2
  (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision)
VALUES ('catalog-event-rate-card-source-draft-v1', 'rate_card_version', 'rate-card-source-draft-v1',
  'source_imported', 'migration:146',
  'Imported source rates as pending business approval and non-executable',
  '{"sourceDocument":"商业化方案.md","approvalStatus":"pending_business_approval"}'::jsonb, 1);
