import { COMMERCIAL_FEATURE_DEFINITIONS } from '@merchant-marketing/contracts'
/** Only capabilities already consumed by commercial entitlement/point/service paths. */
export const COMMERCIAL_BENEFIT_DEFINITIONS = [
  { code: 'max_brands', unit: 'brand', combination: 'absolute', upgradeSemantics: 'absolute', consumer: 'continuous-feature-entitlement' },
  { code: 'max_stores', unit: 'store', combination: 'absolute', upgradeSemantics: 'absolute', consumer: 'continuous-feature-entitlement' },
  { code: 'cloud_storage', unit: 'byte', combination: 'absolute', upgradeSemantics: 'absolute', consumer: 'storage-quota' },
  { code: 'monthly_creative_points', unit: 'point', combination: 'source_batch', upgradeSemantics: 'consumable', consumer: 'creative-point-ledger' },
  { code: 'creative_points', unit: 'point', combination: 'source_batch', upgradeSemantics: 'consumable', consumer: 'creative-point-ledger' },
  { code: 'monthly_one_to_one_hours', unit: 'hour', combination: 'source_batch', upgradeSemantics: 'consumable', consumer: 'service-fulfillment' },
  { code: 'one_to_one_service_hours', unit: 'hour', combination: 'source_batch', upgradeSemantics: 'consumable', consumer: 'service-fulfillment' },
  { code: 'outcome_review_count', unit: 'review', combination: 'source_batch', upgradeSemantics: 'consumable', consumer: 'service-fulfillment' },
  { code: 'first_response_business_hours', unit: 'business_hour', combination: 'contract', upgradeSemantics: 'contract', consumer: 'service-fulfillment' },
  { code: 'grant_count', unit: 'batch', combination: 'plan_metadata', upgradeSemantics: 'none', consumer: 'onboarding-schedule' },
  { code: 'points_per_grant', unit: 'point', combination: 'plan_metadata', upgradeSemantics: 'none', consumer: 'onboarding-schedule' },
  ...COMMERCIAL_FEATURE_DEFINITIONS.map(definition => ({ code: definition.code, name: definition.name, unit: definition.unit, combination: 'boolean_union' as const, upgradeSemantics: 'boolean' as const, consumer: definition.consumer })),
] as const
