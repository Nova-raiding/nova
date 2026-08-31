import { describe, expect, it } from 'vitest'
import { extractMerchantIntent, type IntentEvidence, type PromotionMechanismKind } from './merchant-intent-extractor.js'

function mechanism(result: ReturnType<typeof extractMerchantIntent>, kind: PromotionMechanismKind) {
  return result.promotion.mechanisms.find(item => item.kind === kind)
}

function expectEvidenceMatchesSource(source: string, evidence: readonly IntentEvidence[]) {
  for (const item of evidence) expect(source.slice(item.start, item.end)).toBe(item.text)
}

describe('merchant natural-language intent extractor', () => {
  it('extracts Chinese brand facts, complex promotions, validity and scopes without inventing values', () => {
    const text = '品牌：云岚；定位：轻户外通勤；目标人群：城市女性；品牌调性：克制、可信。淘宝、天猫活动，商品范围：防晒衣A、冰袖B。活动时间从2026年9月1日至2026年9月10日。阶梯优惠：满300元减30元，满500元减80元；满3件8折；满2件赠袜子；满300元可用50元优惠券；预售定金20元，尾款180元；会员价99元。'
    const result = extractMerchantIntent(text)

    expect(result.safeToApply).toBe(true)
    expect(result.ambiguities).toEqual([])
    expect(result.brand).toMatchObject({
      name: { value: '云岚', confidence: 0.98 },
      positioning: { value: '轻户外通勤' },
      audience: { value: '城市女性' },
      tone: { value: ['克制', '可信'] },
    })
    expect(result.promotion.platforms?.value).toEqual(['taobao', 'tmall'])
    expect(result.promotion.products?.value).toEqual(['防晒衣A', '冰袖B'])
    expect(result.promotion.validity?.value).toEqual({ start: { iso: '2026-09-01', precision: 'date' }, end: { iso: '2026-09-10', precision: 'date' } })
    expect(mechanism(result, 'tiered_reduction')?.tiers).toEqual([
      expect.objectContaining({ minimumSpend: { currency: 'CNY', amount: '300.00', minorUnits: 30000 }, reduction: { currency: 'CNY', amount: '30.00', minorUnits: 3000 } }),
      expect.objectContaining({ minimumSpend: { currency: 'CNY', amount: '500.00', minorUnits: 50000 }, reduction: { currency: 'CNY', amount: '80.00', minorUnits: 8000 } }),
    ])
    expect(mechanism(result, 'quantity_discount')).toMatchObject({ minimumQuantity: 3, discountRate: 0.8, complete: true })
    expect(mechanism(result, 'gift')).toMatchObject({ minimumQuantity: 2, giftDescription: '袜子' })
    expect(mechanism(result, 'coupon')).toMatchObject({ minimumSpend: { minorUnits: 30000 }, couponAmount: { minorUnits: 5000 } })
    expect(mechanism(result, 'presale')).toMatchObject({ deposit: { minorUnits: 2000 }, balance: { minorUnits: 18000 } })
    expect(mechanism(result, 'member_price')).toMatchObject({ memberPrice: { currency: 'CNY', amount: '99.00', minorUnits: 9900 } })
    expect(result.promotion.mechanisms.map(item => item.kind)).toEqual(['tiered_reduction', 'quantity_discount', 'gift', 'coupon', 'presale', 'member_price'])
    expectEvidenceMatchesSource(text, [
      ...result.brand.name!.evidence,
      ...result.promotion.mechanisms.flatMap(item => item.evidence),
      ...result.promotion.validity!.evidence,
      ...result.promotion.platforms!.evidence,
      ...result.promotion.products!.evidence,
    ])
  })

  it('extracts equivalent English brand and promotion language with normalized USD and discounts', () => {
    const text = 'Brand name: North Star; positioning: urban outdoor; target audience: city commuters; tone: calm and credible. Run on JD and TikTok Shop. Products: Jacket A and Scarf B. Promotion period from September 1, 2026 to September 10, 2026. Spend $300 and save $30 off; spend $500 get $80 off; buy 3 items and get 20% off; buy 2 items and get a free tote; coupon: $50; deposit $20, balance $180; member price: $99.'
    const result = extractMerchantIntent(text)

    expect(result.safeToApply).toBe(true)
    expect(result.brand).toMatchObject({ name: { value: 'North Star' }, positioning: { value: 'urban outdoor' }, audience: { value: 'city commuters' }, tone: { value: ['calm', 'credible'] } })
    expect(result.promotion.platforms?.value).toEqual(['jd', 'douyin'])
    expect(result.promotion.products?.value).toEqual(['Jacket A', 'Scarf B'])
    expect(result.promotion.validity?.value.start.iso).toBe('2026-09-01')
    expect(mechanism(result, 'tiered_reduction')?.tiers?.[1]).toMatchObject({ minimumSpend: { currency: 'USD', minorUnits: 50000 }, reduction: { minorUnits: 8000 } })
    expect(mechanism(result, 'quantity_discount')).toMatchObject({ minimumQuantity: 3, discountRate: 0.8 })
    expect(mechanism(result, 'gift')).toMatchObject({ giftDescription: 'tote' })
    expect(mechanism(result, 'coupon')?.couponAmount).toEqual({ currency: 'USD', amount: '50.00', minorUnits: 5000 })
    expect(mechanism(result, 'presale')).toMatchObject({ deposit: { minorUnits: 2000 }, balance: { minorUnits: 18000 } })
    expect(mechanism(result, 'member_price')?.memberPrice?.minorUnits).toBe(9900)
  })

  it('fails safe on incomplete promotion and yearless date expressions', () => {
    const text = '品牌：云岚。活动满300减；预售定金20元，尾款；会员价；活动时间9月1日至9月10日。'
    const result = extractMerchantIntent(text)

    expect(result.safeToApply).toBe(false)
    expect(result.brand.name?.value).toBe('云岚')
    expect(result.promotion.validity).toBeUndefined()
    expect(result.promotion.mechanisms).toEqual([])
    expect(result.ambiguities.map(item => item.code)).toEqual(expect.arrayContaining(['PROMOTION_EXPRESSION_INCOMPLETE', 'DATE_RANGE_INVALID']))
    expect(result.questions.every(question => question.evidence.length > 0 && question.prompt.length > 0)).toBe(true)
    expect(result.questions.map(question => question.field)).toEqual(expect.arrayContaining(['promotion', 'promotion.presale.balance', 'promotion.member_price', 'promotion.validity']))
    expectEvidenceMatchesSource(text, result.questions.flatMap(question => question.evidence))
  })

  it('preserves conflicting candidates but withholds singular brand, member-price and date decisions', () => {
    const text = '品牌：云岚；品牌：山海。会员价99元，member price ¥89。活动时间2026-09-01至2026-09-10；活动时间2026-10-01至2026-10-07。'
    const result = extractMerchantIntent(text)

    expect(result.safeToApply).toBe(false)
    expect(result.brand.name).toBeUndefined()
    expect(result.promotion.validity).toBeUndefined()
    expect(result.promotion.mechanisms.filter(item => item.kind === 'member_price').map(item => item.memberPrice?.minorUnits)).toEqual([9900, 8900])
    expect(result.ambiguities).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BRAND_VALUE_CONFLICT', field: 'brand.name', candidates: ['云岚', '山海'] }),
      expect.objectContaining({ code: 'PROMOTION_VALUE_CONFLICT', field: 'promotion.member_price' }),
      expect.objectContaining({ code: 'DATE_RANGE_CONFLICT', field: 'promotion.validity' }),
    ]))
  })

  it('rejects invalid amounts, discounts and reversed dates instead of normalizing unsafe values', () => {
    const text = '满100元减120元；满3件10折；活动时间2026-09-10至2026-09-01。'
    const result = extractMerchantIntent(text)

    expect(result.safeToApply).toBe(false)
    expect(result.promotion.mechanisms).toEqual([])
    expect(result.promotion.validity).toBeUndefined()
    expect(result.ambiguities.map(item => item.code)).toEqual(['PROMOTION_VALUE_INVALID', 'PROMOTION_VALUE_INVALID', 'DATE_RANGE_INVALID'])
    expect(result.questions).toHaveLength(3)
  })

  it('supports explicit platform aliases and does not infer missing promotion fields', () => {
    const text = 'Brand: Pine. Run this on Shop-X for Products: Coat A. Gift campaign pending merchant details.'
    const result = extractMerchantIntent(text, { platformAliases: { shop_x: ['Shop-X'] } })

    expect(result.brand.name?.value).toBe('Pine')
    expect(result.promotion.platforms?.value).toEqual(['shop_x'])
    expect(result.promotion.products?.value).toEqual(['Coat A'])
    expect(result.promotion.mechanisms).toEqual([])
    expect(result.promotion.validity).toBeUndefined()
    expect(result.safeToApply).toBe(true)
  })

  it('normalizes decimal money and timezone-bearing minute windows', () => {
    const text = '会员价99.90元，活动时间从2026-09-01 08:30+08:00至2026-09-10 23:00+08:00。'
    const result = extractMerchantIntent(text)

    expect(result.safeToApply).toBe(true)
    expect(mechanism(result, 'member_price')?.memberPrice).toEqual({ currency: 'CNY', amount: '99.90', minorUnits: 9990 })
    expect(result.promotion.validity?.value).toEqual({
      start: { iso: '2026-09-01T08:30:00+08:00', precision: 'minute', timezone: '+08:00' },
      end: { iso: '2026-09-10T23:00:00+08:00', precision: 'minute', timezone: '+08:00' },
    })
  })

  it('surfaces recognized-but-incomplete promotion values instead of silently ignoring them', () => {
    const text = '方案一仅定金30元；方案二仅尾款170元；满3件折；满300元可用优惠券；coupon: 20；member price 89。'
    const result = extractMerchantIntent(text)

    expect(result.safeToApply).toBe(false)
    expect(result.promotion.mechanisms).toEqual([])
    expect(result.questions.map(question => question.field)).toEqual(expect.arrayContaining([
      'promotion.presale.balance',
      'promotion.presale.deposit',
      'promotion.quantity_discount',
      'promotion.coupon',
      'promotion.member_price',
    ]))
    expectEvidenceMatchesSource(text, result.questions.flatMap(question => question.evidence))
  })

  it('fails safe for conflicting tier currencies or reductions while preserving every stated tier', () => {
    const text = '阶梯活动满300元减30元，满300元减40元，spend $500 save $80 off。'
    const result = extractMerchantIntent(text)

    expect(result.safeToApply).toBe(false)
    expect(mechanism(result, 'tiered_reduction')?.tiers).toHaveLength(3)
    expect(result.ambiguities).toContainEqual(expect.objectContaining({ code: 'PROMOTION_VALUE_CONFLICT', field: 'promotion.tiered_reduction' }))
  })
})
