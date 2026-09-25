-- Publish the owner-approved OCR rate without changing immutable v1/v2 facts.
-- This OCR-specific formula is ceil(provider cost in CNY * 2), minimum 1 point.
-- The names below are the two CHECK constraints installed by migration 146.
ALTER TABLE creative_point_rate_rules_v2
  DROP CONSTRAINT creative_point_rate_rules_v2_pricing_mode_check,
  DROP CONSTRAINT creative_point_rate_rules_v2_check;

ALTER TABLE creative_point_rate_rules_v2
  ADD CONSTRAINT creative_point_rate_pricing_mode_v3_check
    CHECK (pricing_mode IN ('fixed', 'starts_at', 'unresolved', 'variable')),
  ADD CONSTRAINT creative_point_rate_executable_v3_check
    CHECK (NOT executable OR (
      (pricing_mode = 'fixed' AND integer_points IS NOT NULL)
      OR (action_code = 'ocr.extract' AND unit = 'request' AND pricing_mode = 'variable'
          AND integer_points IS NULL
          AND variable_formula = '{"kind":"cost_cny_x2_ceil_min1"}'::jsonb)
    ));

INSERT INTO creative_point_rate_card_versions_v2
  (id, version, lifecycle, executable, approval_status, checksum, effective_at)
VALUES
  ('rate-card-ocr-cost-v3', 3, 'approved', true, 'approved',
   encode(sha256(convert_to('commercial.points.ocr.cost_cny_x2_ceil_min1.v3', 'UTF8')), 'hex'), now());

INSERT INTO creative_point_rate_rules_v2
  (id, rate_card_version_id, action_code, unit, integer_points, pricing_mode, variable_formula, executable, blockers)
VALUES
  ('rate-ocr-extract-cost-v3', 'rate-card-ocr-cost-v3', 'ocr.extract', 'request', NULL,
   'variable', '{"kind":"cost_cny_x2_ceil_min1"}'::jsonb, true, '[]'::jsonb);

INSERT INTO commercial_catalog_events_v2
  (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision)
VALUES
  ('catalog-event-rate-card-ocr-cost-v3', 'rate_card_version', 'rate-card-ocr-cost-v3',
   'published', 'migration:247', 'Publish approved OCR provider-cost multiplier rate',
   '{"action_code":"ocr.extract","formula":"cost_cny_x2_ceil_min1","currency":"CNY","rounding":"ceil","minimum_points":1}'::jsonb, 1);
