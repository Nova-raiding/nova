const units: Record<string, string> = {
  GB_DECIMAL: 'GB', byte: '字节', point: '点', points: '点', creative_points: '点',
  brand: '个品牌', brands: '个品牌', store: '家店铺', stores: '家店铺',
  hour: '小时', review: '次', business_hour: '工作小时', monthly_grants: '期', g: 'g',
}
type BenefitRecord = Record<string, unknown> & { code?: unknown }
const recordOf = (value: unknown): BenefitRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as BenefitRecord : {}

/** Formats a persisted benefit for display while leaving its source snapshot untouched. */
export function commercialBenefitValue(value: unknown): string {
  const benefit = recordOf(value)
  const code = typeof benefit.code === 'string' ? benefit.code : ''
  const quantity = benefit.quantity
  if (code.startsWith('feature.')) {
    if (quantity === 1) return '包含'
    if (quantity === 0) return '不包含'
    return '权限待核实'
  }

  const rawValue = benefit.rawValue ?? benefit.raw_value
  const normalized = benefit.normalizedValue ?? benefit.normalized_value
  const amount = rawValue ?? normalized ?? quantity
  if (amount === null || amount === undefined) return '额度待核实'
  const rawUnit = benefit.rawUnit ?? benefit.raw_unit ?? benefit.unit
  const unit = code === 'cloud_storage' && rawValue == null && normalized != null
    ? '字节'
    : typeof rawUnit === 'string' ? units[rawUnit] ?? rawUnit : ''
  if (typeof rawValue === 'string' && rawValue.trim()) {
    const hasSourceUnit = rawUnit === 'GB_DECIMAL'
      ? /(?:g|gb)$/iu.test(rawValue.trim())
      : typeof rawUnit === 'string' && Boolean(unit) && (rawValue.trim().endsWith(unit) || rawValue.trim().endsWith(rawUnit))
    if (hasSourceUnit) return rawValue
  }
  return `${String(amount)}${unit}`
}
