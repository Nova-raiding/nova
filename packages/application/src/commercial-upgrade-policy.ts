/** Exact, replayable current-period upgrade arithmetic. Persistence owns the
 * quote/source revision locks and payment acceptance; this module never grants. */
export type SupportedCommercialCycle = { unit: 'month' | 'day'; count: number; cadence: 'once' | 'monthly' }

/** This is the deliberately small set of period and grant combinations backed
 * by the V3 period writer and scheduled-grant dispatcher. Keep legacy readers
 * separate: a new sale/quote must carry explicit executable cycle data. */
export function assertSupportedCommercialCycleGrantPolicy(input: {
  cycle: unknown
  pointGrantPolicy: unknown
}): SupportedCommercialCycle {
  const cycle = input.cycle
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) throw new Error('COMMERCIAL_CYCLE_POLICY_UNRESOLVED')
  const value = cycle as Record<string, unknown>
  const unit = value.unit
  const count = value.count
  if (!Number.isSafeInteger(count) || Number(count) < 1) throw new Error('COMMERCIAL_CYCLE_POLICY_UNRESOLVED')
  if (unit === 'month' && ![1, 3, 6, 12].includes(Number(count))) throw new Error('COMMERCIAL_CYCLE_UNSUPPORTED')
  if (unit === 'day' && Number(count) > 366) throw new Error('COMMERCIAL_CYCLE_UNSUPPORTED')
  if (unit !== 'month' && unit !== 'day') throw new Error('COMMERCIAL_CYCLE_UNSUPPORTED')

  const grantPolicy = input.pointGrantPolicy && typeof input.pointGrantPolicy === 'object' && !Array.isArray(input.pointGrantPolicy)
    ? input.pointGrantPolicy as Record<string, unknown>
    : undefined
  const cadence = grantPolicy?.cadence ?? (Number(count) === 1 ? 'once' : undefined)
  if (cadence !== 'once' && cadence !== 'monthly') throw new Error('COMMERCIAL_POINT_GRANT_CADENCE_UNRESOLVED')
  if (unit === 'day' && cadence !== 'once') throw new Error('COMMERCIAL_POINT_GRANT_CADENCE_UNSUPPORTED')

  return { unit, count: Number(count), cadence }
}

export interface CommercialUpgradeBenefitDefinition {
  readonly code: string
  readonly unit: string
  readonly kind: 'absolute' | 'consumable' | 'boolean' | 'lower_is_better'
}
export interface CommercialUpgradeBenefit {
  readonly code: string
  readonly quantity: number | null
  readonly normalizedValue?: number | null
}
export interface CommercialUpgradePlan {
  readonly planFamily: string
  readonly tierRank: number | null
  readonly cycleKey: string
  /** Whole-cycle transaction price, never the preceding upgrade payment. */
  readonly cyclePriceFen: number
  readonly benefits: readonly CommercialUpgradeBenefit[]
}
export interface CommercialUpgradeCarry {
  /** Cumulative exact entitlement increments across successful upgrade events. */
  readonly numerator: string
  readonly denominator: string
  readonly awardedUnits: number
}
export interface CommercialUpgradeBenefitIncrement {
  readonly code: string
  readonly unit: string
  readonly kind: CommercialUpgradeBenefitDefinition['kind']
  readonly sourceQuantity: number
  readonly targetQuantity: number
  readonly quantity: number
  readonly exactNumerator: string
  readonly exactDenominator: string
  readonly carry: CommercialUpgradeCarry | null
}
export interface CommercialUpgradeCalculation {
  readonly algorithmVersion: 'remaining-period-v1'
  readonly amountFen: number
  readonly priceNumerator: string
  readonly priceDenominator: string
  readonly remainingMs: number
  readonly totalMs: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly quotedAt: string
  readonly benefitIncrements: readonly CommercialUpgradeBenefitIncrement[]
}
export class CommercialUpgradePolicyError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CommercialUpgradePolicyError' }
}
const fail = (code: string): never => { throw new CommercialUpgradePolicyError(code) }
function integer(value: number, code: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) return fail(code)
  return BigInt(value)
}
function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return fail('COMMERCIAL_UPGRADE_VALUE_OVERFLOW')
  return Number(value)
}
function instant(value: string): number {
  const time = Date.parse(value)
  if (!Number.isSafeInteger(time) || new Date(time).toISOString() !== value) return fail('COMMERCIAL_UPGRADE_PERIOD_INVALID')
  return time
}
function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right]
  return left
}
function reduce(numerator: bigint, denominator: bigint): [bigint, bigint] {
  const divisor = gcd(numerator, denominator)
  return [numerator / divisor, denominator / divisor]
}
function quantities(benefits: readonly CommercialUpgradeBenefit[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const benefit of benefits) {
    if (result.has(benefit.code)) return fail('COMMERCIAL_UPGRADE_DUPLICATE_BENEFIT')
    const quantity = benefit.normalizedValue ?? benefit.quantity
    if (quantity === null) return fail('COMMERCIAL_UPGRADE_BENEFIT_UNRESOLVED')
    integer(quantity, 'COMMERCIAL_UPGRADE_BENEFIT_INVALID')
    result.set(benefit.code, quantity)
  }
  return result
}
function parseCarry(value: CommercialUpgradeCarry): [bigint, bigint, bigint] {
  if (value.numerator.length > 512 || value.denominator.length > 512 || !/^(0|[1-9][0-9]*)$/u.test(value.numerator) || !/^[1-9][0-9]*$/u.test(value.denominator)) return fail('COMMERCIAL_UPGRADE_CARRY_INVALID')
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator)
  const awarded = integer(value.awardedUnits, 'COMMERCIAL_UPGRADE_CARRY_INVALID')
  // A committed accumulator must have awarded all previous whole units.
  if (numerator / denominator !== awarded) return fail('COMMERCIAL_UPGRADE_CARRY_INVALID')
  return [numerator, denominator, awarded]
}

export function calculateCommercialUpgrade(input: {
  readonly source: CommercialUpgradePlan
  readonly target: CommercialUpgradePlan
  readonly periodStart: string
  readonly periodEnd: string
  readonly quotedAt: string
  /** Only approved definitions backed by registered runtime consumers. */
  readonly definitions: readonly CommercialUpgradeBenefitDefinition[]
  readonly carry?: Readonly<Record<string, CommercialUpgradeCarry>>
}): CommercialUpgradeCalculation {
  const { source, target } = input
  if (!source.planFamily || source.planFamily !== target.planFamily) return fail('COMMERCIAL_UPGRADE_FAMILY_MISMATCH')
  if (source.tierRank === null || target.tierRank === null || !Number.isSafeInteger(source.tierRank) || !Number.isSafeInteger(target.tierRank)
    || source.tierRank < 1 || target.tierRank <= source.tierRank) return fail('COMMERCIAL_UPGRADE_TIER_INVALID')
  if (!source.cycleKey || source.cycleKey !== target.cycleKey) return fail('COMMERCIAL_UPGRADE_CYCLE_MISMATCH')
  const sourcePrice = integer(source.cyclePriceFen, 'COMMERCIAL_UPGRADE_PRICE_INVALID')
  const targetPrice = integer(target.cyclePriceFen, 'COMMERCIAL_UPGRADE_PRICE_INVALID')
  if (sourcePrice <= 0n || targetPrice <= sourcePrice) return fail('COMMERCIAL_UPGRADE_NON_POSITIVE_PRICE_DIFFERENCE')
  const start = instant(input.periodStart), end = instant(input.periodEnd), quoted = instant(input.quotedAt)
  if (start >= end || quoted < start || quoted >= end) return fail('COMMERCIAL_UPGRADE_PERIOD_EXPIRED')
  const totalMs = end - start, remainingMs = end - quoted
  const denominator = integer(totalMs, 'COMMERCIAL_UPGRADE_PERIOD_INVALID')
  const remaining = integer(remainingMs, 'COMMERCIAL_UPGRADE_PERIOD_INVALID')
  const priceNumerator = (targetPrice - sourcePrice) * remaining
  // Positive integer fen: round half up exactly once at the final boundary.
  const amountFen = safeNumber((2n * priceNumerator + denominator) / (2n * denominator))
  if (amountFen === 0) return fail('COMMERCIAL_UPGRADE_NON_POSITIVE_PRICE_DIFFERENCE')
  const sourceBenefits = quantities(source.benefits), targetBenefits = quantities(target.benefits)
  const definitions = new Map(input.definitions.map(definition => [definition.code, definition]))
  if (definitions.size !== input.definitions.length) return fail('COMMERCIAL_UPGRADE_DEFINITION_INVALID')
  for (const code of Object.keys(input.carry ?? {})) {
    if (definitions.get(code)?.kind !== 'consumable' || !sourceBenefits.has(code) || !targetBenefits.has(code)) return fail('COMMERCIAL_UPGRADE_CARRY_INVALID')
  }
  const benefitIncrements: CommercialUpgradeBenefitIncrement[] = []
  for (const code of new Set([...sourceBenefits.keys(), ...targetBenefits.keys()])) {
    const definition = definitions.get(code)
    if (!definition || !definition.unit || !['absolute', 'consumable', 'boolean', 'lower_is_better'].includes(definition.kind)) return fail('COMMERCIAL_UPGRADE_CONSUMER_UNAVAILABLE')
    const from = sourceBenefits.get(code) ?? 0, to = targetBenefits.get(code)
    if (to === undefined) return fail('COMMERCIAL_UPGRADE_BENEFITS_NOT_MONOTONE')
    if (definition.kind === 'lower_is_better') {
      if (!sourceBenefits.has(code) || to > from) return fail('COMMERCIAL_UPGRADE_BENEFITS_NOT_MONOTONE')
    } else if (to < from) return fail('COMMERCIAL_UPGRADE_BENEFITS_NOT_MONOTONE')
    if (definition.kind === 'boolean' && (from > 1 || to > 1)) return fail('COMMERCIAL_UPGRADE_BENEFIT_INVALID')
    let quantity = to, exactNumerator = BigInt(to), exactDenominator = 1n
    let carry: CommercialUpgradeCarry | null = null
    if (definition.kind === 'consumable') {
      exactNumerator = BigInt(to - from) * remaining
      exactDenominator = denominator
      const previous = input.carry?.[code]
      const [priorNumerator, priorDenominator, priorAwarded] = previous ? parseCarry(previous) : [0n, 1n, 0n]
      const [cumulativeNumerator, cumulativeDenominator] = reduce(priorNumerator * exactDenominator + exactNumerator * priorDenominator, priorDenominator * exactDenominator)
      const awarded = cumulativeNumerator / cumulativeDenominator
      quantity = safeNumber(awarded - priorAwarded)
      carry = { numerator: cumulativeNumerator.toString(), denominator: cumulativeDenominator.toString(), awardedUnits: safeNumber(awarded) }
    }
    const [reducedNumerator, reducedDenominator] = reduce(exactNumerator, exactDenominator)
    benefitIncrements.push({ code, unit: definition.unit, kind: definition.kind, sourceQuantity: from, targetQuantity: to, quantity,
      exactNumerator: reducedNumerator.toString(), exactDenominator: reducedDenominator.toString(), carry })
  }
  const [reducedPriceNumerator, reducedPriceDenominator] = reduce(priceNumerator, denominator)
  return { algorithmVersion: 'remaining-period-v1', amountFen, priceNumerator: reducedPriceNumerator.toString(), priceDenominator: reducedPriceDenominator.toString(),
    remainingMs, totalMs, periodStart: new Date(start).toISOString(), periodEnd: new Date(end).toISOString(), quotedAt: new Date(quoted).toISOString(), benefitIncrements }
}
