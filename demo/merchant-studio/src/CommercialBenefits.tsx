import { COMMERCIAL_FEATURE_DEFINITIONS } from '../../../packages/contracts/src/commercial-feature-definitions.js'
import { commercialBenefitValue } from './commercial-benefit-value.js'

const featureNames = new Map<string, string>(COMMERCIAL_FEATURE_DEFINITIONS.map(feature => [feature.code, feature.name]))
const benefitNames: Record<string, string> = {
  creative_points: '创意点', monthly_creative_points: '每期套餐创意点', cloud_storage: '共享存储',
  max_brands: '品牌额度', max_stores: '店铺额度', first_response_business_hours: '首响时间',
  grant_count: '赠点批次', points_per_grant: '每批赠点', monthly_one_to_one_hours: '每期一对一服务',
  one_to_one_service_hours: '一对一服务', outcome_review_count: '经营复盘',
}
type BenefitRecord = Record<string, unknown> & { code?: unknown }
const recordOf = (value: unknown): BenefitRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as BenefitRecord : {}

/** Human-readable name for a registered right; raw keys are kept in the expandable source snapshot. */
export function commercialBenefitName(code: string, explicitName?: unknown): string {
  if (typeof explicitName === 'string' && explicitName.trim()) return explicitName
  return featureNames.get(code) ?? benefitNames[code] ?? (code.startsWith('feature.') ? '未登记功能权限' : '其他权益')
}

export { commercialBenefitValue } from './commercial-benefit-value.js'

export function commercialBenefitsSummary(benefits: unknown[]): string {
  return benefits.map(value => {
    const benefit = recordOf(value)
    const code = typeof benefit.code === 'string' ? benefit.code : ''
    if (!code) return ''
    return `${commercialBenefitName(code, benefit.name)}：${commercialBenefitValue(benefit)}`
  }).filter(Boolean).join('；') || '权益以服务端冻结合同为准'
}

export function CommercialBenefitSnapshot({ benefits, label = '查看原始权益快照' }: { benefits: unknown[]; label?: string }) {
  return <div className="commercial-benefit-snapshot">
    <p>{commercialBenefitsSummary(benefits)}</p>
    <details><summary>{label}</summary><pre>{JSON.stringify(benefits, null, 2)}</pre></details>
  </div>
}
