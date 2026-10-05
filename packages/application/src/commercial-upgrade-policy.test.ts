import { describe, expect, it } from 'vitest'
import { assertSupportedCommercialCycleGrantPolicy, calculateCommercialUpgrade, type CommercialUpgradePlan } from './commercial-upgrade-policy.js'

const definitions = [
  { code: 'max_brands', unit: 'brand', kind: 'absolute' as const },
  { code: 'monthly_creative_points', unit: 'point', kind: 'consumable' as const },
  { code: 'feature.text', unit: 'permission', kind: 'boolean' as const },
  { code: 'first_response_business_hours', unit: 'business_hour', kind: 'lower_is_better' as const },
]
const plan = (tierRank: number, cyclePriceFen: number, points: number): CommercialUpgradePlan => ({ planFamily: 'standard', tierRank, cycleKey: 'month:1', cyclePriceFen,
  benefits: [{ code: 'max_brands', quantity: tierRank }, { code: 'monthly_creative_points', quantity: points },
    { code: 'feature.text', quantity: 1 }, { code: 'first_response_business_hours', quantity: 4 - tierRank }] })
const period = { periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', quotedAt: '2026-09-16T00:00:00.000Z' }
const calculate = (source: CommercialUpgradePlan, target: CommercialUpgradePlan, overrides = {}) => calculateCommercialUpgrade({ source, target, ...period, definitions, ...overrides })

describe('exact current-period upgrade policy', () => {
  it.each([[1, 200000, 2, 500000, 150000], [2, 500000, 3, 1000000, 250000], [1, 200000, 3, 1000000, 400000]])('quotes fixed rank %i at the remaining half period', (from, fromPrice, to, toPrice, expected) => {
    expect(calculate(plan(from, fromPrice, 10), plan(to, toPrice, 20)).amountFen).toBe(expected)
  })
  it('uses transaction cycle prices and real leap-month duration with one final half-up rounding', () => {
    const result = calculate(plan(1, 200001, 10), plan(2, 500002, 20), {
      periodStart: '2028-02-01T00:00:00.000Z', periodEnd: '2028-03-01T00:00:00.000Z', quotedAt: '2028-02-15T12:00:00.000Z',
    })
    expect(result.amountFen).toBe(150001)
    expect(result.totalMs).toBe(29 * 86400000)
    expect(result.priceNumerator).toBe('300001')
    expect(result.priceDenominator).toBe('2')
    expect(result.periodEnd).toBe('2028-03-01T00:00:00.000Z')
  })
  it('switches absolute limits and boolean grants without reprorating them and prorates only consumables', () => {
    const result = calculate(plan(1, 200000, 5000), plan(2, 500000, 12500))
    expect(result.benefitIncrements.find(item => item.code === 'max_brands')).toMatchObject({ quantity: 2, carry: null })
    expect(result.benefitIncrements.find(item => item.code === 'feature.text')).toMatchObject({ quantity: 1, carry: null })
    expect(result.benefitIncrements.find(item => item.code === 'monthly_creative_points')).toMatchObject({ quantity: 3750,
      exactNumerator: '3750', exactDenominator: '1', carry: { numerator: '3750', denominator: '1', awardedUnits: 3750 } })
  })
  it('retains fractional carry across consecutive upgrades so path rounding does not lose a unit', () => {
    const basic = plan(1, 200000, 10), growth = plan(2, 500000, 11), premium = plan(3, 1000000, 12)
    const first = calculate(basic, growth)
    const firstPoints = first.benefitIncrements.find(item => item.code === 'monthly_creative_points')!
    expect(firstPoints.quantity).toBe(0)
    const second = calculate(growth, premium, { carry: { monthly_creative_points: firstPoints.carry! } })
    const direct = calculate(basic, premium)
    expect(second.amountFen).toBe(250000) // whole target/source prices, never preceding 150000 payment
    expect(second.benefitIncrements.find(item => item.code === 'monthly_creative_points')!.quantity).toBe(1)
    expect(direct.benefitIncrements.find(item => item.code === 'monthly_creative_points')!.quantity).toBe(1)
    expect(JSON.parse(JSON.stringify(second))).toEqual(second)
  })
  it('adds exact carry with differing event times instead of repricing past entitlement increments', () => {
    const first = calculate(plan(1, 200000, 10), plan(2, 500000, 11))
    const second = calculate(plan(2, 500000, 11), plan(3, 1000000, 14), {
      quotedAt: '2026-09-21T00:00:00.000Z', carry: { monthly_creative_points: first.benefitIncrements.find(item => item.code === 'monthly_creative_points')!.carry! },
    })
    expect(second.benefitIncrements.find(item => item.code === 'monthly_creative_points')).toMatchObject({ quantity: 1, carry: { numerator: '3', denominator: '2', awardedUnits: 1 } })
  })
  it.each([
    ['custom rank', { target: { ...plan(3, 1000000, 20), tierRank: null } }],
    ['same rank', { target: plan(1, 500000, 20) }],
    ['different family', { target: { ...plan(2, 500000, 20), planFamily: 'private' } }],
    ['different cycle', { target: { ...plan(2, 500000, 20), cycleKey: 'month:12' } }],
    ['non-positive delta', { target: plan(2, 200000, 20) }],
    ['source price zero', { source: plan(1, 0, 10) }],
    ['period already expired', { quotedAt: period.periodEnd }],
    ['period not started', { quotedAt: '2026-08-31T23:59:59.999Z' }],
    ['consumer absent', { definitions: [] }],
    ['lost quota', { target: plan(2, 500000, 9) }],
    ['bad carry', { carry: { monthly_creative_points: { numerator: '3', denominator: '2', awardedUnits: 0 } } }],
    ['carry attached to absolute', { carry: { max_brands: { numerator: '0', denominator: '1', awardedUnits: 0 } } }],
  ])('blocks %s before an order can be created', (_case, overrides) => {
    expect(() => calculate(plan(1, 200000, 10), plan(2, 500000, 20), overrides)).toThrow()
  })
  it('does not lose exactness near the safe price boundary', () => {
    const value = calculate(plan(1, 1, 10), plan(2, Number.MAX_SAFE_INTEGER, 20))
    expect(value.amountFen).toBe(4503599627370495)
  })
  it('rejects duplicate, unregistered and decreasing-response benefits', () => {
    const target = plan(2, 500000, 20)
    expect(() => calculate(plan(1, 200000, 10), { ...target, benefits: [...target.benefits, target.benefits[0]!] })).toThrow('COMMERCIAL_UPGRADE_DUPLICATE_BENEFIT')
    expect(() => calculate(plan(1, 200000, 10), { ...target, benefits: [...target.benefits, { code: 'unknown.permission', quantity: 1 }] })).toThrow('COMMERCIAL_UPGRADE_CONSUMER_UNAVAILABLE')
    expect(() => calculate(plan(1, 200000, 10), { ...target, benefits: target.benefits.map(item => item.code === 'first_response_business_hours' ? { ...item, quantity: 5 } : item) })).toThrow('COMMERCIAL_UPGRADE_BENEFITS_NOT_MONOTONE')
  })
})

describe('supported commercial period and point-grant cadence', () => {
  it.each([
    [{ unit: 'month', count: 1 }, 'once', { unit: 'month', count: 1, cadence: 'once' }],
    [{ unit: 'month', count: 1 }, 'monthly', { unit: 'month', count: 1, cadence: 'monthly' }],
    [{ unit: 'month', count: 3 }, 'once', { unit: 'month', count: 3, cadence: 'once' }],
    [{ unit: 'month', count: 3 }, 'monthly', { unit: 'month', count: 3, cadence: 'monthly' }],
    [{ unit: 'month', count: 6 }, 'once', { unit: 'month', count: 6, cadence: 'once' }],
    [{ unit: 'month', count: 6 }, 'monthly', { unit: 'month', count: 6, cadence: 'monthly' }],
    [{ unit: 'month', count: 12 }, 'once', { unit: 'month', count: 12, cadence: 'once' }],
    [{ unit: 'month', count: 12 }, 'monthly', { unit: 'month', count: 12, cadence: 'monthly' }],
    [{ unit: 'day', count: 30 }, 'once', { unit: 'day', count: 30, cadence: 'once' }],
  ] as const)('accepts cycle %o with %s point cadence', (cycle, cadence, expected) => {
    expect(assertSupportedCommercialCycleGrantPolicy({ cycle, pointGrantPolicy: { cadence } })).toEqual(expected)
  })

  it.each([
    ['missing explicit cycle', { cycle: undefined, pointGrantPolicy: { cadence: 'once' } }],
    ['unsupported month count', { cycle: { unit: 'month', count: 2 }, pointGrantPolicy: { cadence: 'once' } }],
    ['unsupported year count', { cycle: { unit: 'month', count: 24 }, pointGrantPolicy: { cadence: 'monthly' } }],
    ['day cadence monthly', { cycle: { unit: 'day', count: 30 }, pointGrantPolicy: { cadence: 'monthly' } }],
    ['multi-month cadence missing', { cycle: { unit: 'month', count: 3 }, pointGrantPolicy: undefined }],
    ['multi-day cadence missing', { cycle: { unit: 'day', count: 30 }, pointGrantPolicy: undefined }],
    ['non-positive day count', { cycle: { unit: 'day', count: 0 }, pointGrantPolicy: { cadence: 'once' } }],
    ['day count beyond period writer', { cycle: { unit: 'day', count: 367 }, pointGrantPolicy: { cadence: 'once' } }],
    ['unknown cadence', { cycle: { unit: 'month', count: 3 }, pointGrantPolicy: { cadence: 'weekly' } }],
  ])('fails closed for %s', (_case, input) => {
    expect(() => assertSupportedCommercialCycleGrantPolicy(input)).toThrow()
  })
})
