-- Publish a new OCR rate; preserve v3 for reservations created before v4.
-- Actual provider cost <= CNY 0.30 is free. Above that threshold, charge
-- ceil(cost CNY * 2) creative points, minimum 1 point.
ALTER TABLE creative_point_rate_rules_v2
  DROP CONSTRAINT creative_point_rate_executable_v3_check;

ALTER TABLE creative_point_rate_rules_v2
  ADD CONSTRAINT creative_point_rate_executable_v4_check
    CHECK (NOT executable OR (
      (pricing_mode = 'fixed' AND integer_points IS NOT NULL)
      OR (action_code = 'ocr.extract' AND unit = 'request' AND pricing_mode = 'variable'
          AND integer_points IS NULL
          AND variable_formula IN (
            '{"kind":"cost_cny_x2_ceil_min1"}'::jsonb,
            '{"kind":"cost_cny_threshold_x2_ceil_v1","free_when_cost_cny_lte":0.3,"multiplier":2,"min_paid_points":1}'::jsonb
          ))
    ));

INSERT INTO creative_point_rate_card_versions_v2
  (id, version, lifecycle, executable, approval_status, checksum, effective_at)
VALUES
  ('rate-card-ocr-free-threshold-v4', 4, 'approved', true, 'approved',
   encode(sha256(convert_to('commercial.points.ocr.free_lte_0.30_cost_cny_x2_ceil_min1.v4', 'UTF8')), 'hex'), now());

INSERT INTO creative_point_rate_rules_v2
  (id, rate_card_version_id, action_code, unit, integer_points, pricing_mode, variable_formula, executable, blockers)
VALUES
  ('rate-ocr-extract-free-threshold-v4', 'rate-card-ocr-free-threshold-v4', 'ocr.extract', 'request', NULL,
   'variable', '{"kind":"cost_cny_threshold_x2_ceil_v1","free_when_cost_cny_lte":0.3,"multiplier":2,"min_paid_points":1}'::jsonb,
   true, '[]'::jsonb);

INSERT INTO commercial_catalog_events_v2
  (id, aggregate_type, aggregate_id, event_type, actor_id, reason, evidence, revision)
VALUES
  ('catalog-event-rate-card-ocr-free-threshold-v4', 'rate_card_version', 'rate-card-ocr-free-threshold-v4',
   'published', 'migration:248', 'Publish approved OCR free threshold at CNY 0.30',
   '{"action_code":"ocr.extract","formula":"cost_cny_threshold_x2_ceil_v1","currency":"CNY","free_when_cost_cny_lte":0.3,"multiplier":2,"rounding":"ceil","min_paid_points":1}'::jsonb, 1);
