-- 176_private_trial_entitlement_benefits: complete the immutable benefit rows
-- for the already-published private validation SKU. The payload alone is not
-- an executable entitlement; quota and point gates read normalized benefits.
INSERT INTO commercial_catalog_sku_benefits
  (id, sku_version_id, benefit_code, quantity, raw_value, raw_unit, normalized_value, policy_ref, metadata)
VALUES
  ('benefit-private-brands-v3', 'sku-version-private-validation-7d-v3', 'max_brands', 1, NULL, 'brand', NULL, 'commercial.private_validation.v1', '{}'::jsonb),
  ('benefit-private-stores-v3', 'sku-version-private-validation-7d-v3', 'max_stores', 1, NULL, 'store', NULL, 'commercial.private_validation.v1', '{}'::jsonb),
  ('benefit-private-points-v3', 'sku-version-private-validation-7d-v3', 'creative_points', 500, NULL, 'creative_points', NULL, 'commercial.private_validation.v1', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
