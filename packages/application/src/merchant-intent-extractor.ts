export interface IntentEvidence {
  text: string
  start: number
  end: number
}

export interface ExtractedIntentValue<T> {
  value: T
  confidence: number
  evidence: IntentEvidence[]
}

export interface NormalizedMoney {
  currency: 'CNY' | 'USD'
  amount: string
  minorUnits: number
}

export interface NormalizedDateTime {
  iso: string
  precision: 'date' | 'minute'
  timezone?: string
}

export interface MerchantBrandIntent {
  name?: ExtractedIntentValue<string>
  positioning?: ExtractedIntentValue<string>
  audience?: ExtractedIntentValue<string>
  tone?: ExtractedIntentValue<string[]>
}

export type PromotionMechanismKind =
  | 'threshold_reduction'
  | 'quantity_discount'
  | 'tiered_reduction'
  | 'gift'
  | 'coupon'
  | 'presale'
  | 'member_price'

export interface PromotionTier {
  minimumSpend: NormalizedMoney
  reduction: NormalizedMoney
  evidence: IntentEvidence
}

export interface PromotionMechanism {
  kind: PromotionMechanismKind
  confidence: number
  evidence: IntentEvidence[]
  complete: boolean
  minimumSpend?: NormalizedMoney
  reduction?: NormalizedMoney
  minimumQuantity?: number
  discountRate?: number
  tiers?: PromotionTier[]
  giftDescription?: string
  couponAmount?: NormalizedMoney
  deposit?: NormalizedMoney
  balance?: NormalizedMoney
  memberPrice?: NormalizedMoney
}

export interface PromotionValidity {
  start: NormalizedDateTime
  end: NormalizedDateTime
}

export interface MerchantPromotionIntent {
  mechanisms: PromotionMechanism[]
  validity?: ExtractedIntentValue<PromotionValidity>
  platforms?: ExtractedIntentValue<string[]>
  products?: ExtractedIntentValue<string[]>
}

export type MerchantIntentIssueCode =
  | 'BRAND_VALUE_CONFLICT'
  | 'PROMOTION_VALUE_CONFLICT'
  | 'PROMOTION_EXPRESSION_INCOMPLETE'
  | 'PROMOTION_VALUE_INVALID'
  | 'DATE_RANGE_INVALID'
  | 'DATE_RANGE_CONFLICT'

export interface MerchantIntentIssue {
  code: MerchantIntentIssueCode
  field: string
  message: string
  evidence: IntentEvidence[]
  candidates?: string[]
}

export interface MerchantIntentQuestion {
  id: string
  field: string
  prompt: string
  reason: MerchantIntentIssueCode
  evidence: IntentEvidence[]
  candidates?: string[]
}

export interface MerchantIntentExtraction {
  sourceText: string
  brand: MerchantBrandIntent
  promotion: MerchantPromotionIntent
  ambiguities: MerchantIntentIssue[]
  questions: MerchantIntentQuestion[]
  /** False means downstream code must not persist or execute the extracted promotion. */
  safeToApply: boolean
}

export interface MerchantIntentExtractorOptions {
  platformAliases?: Readonly<Record<string, readonly string[]>>
}

interface MatchRecord {
  match: RegExpExecArray
  evidence: IntentEvidence
}

const DEFAULT_PLATFORM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  taobao: ['淘宝', 'taobao'],
  tmall: ['天猫', 'tmall'],
  jd: ['京东', 'jd', 'jingdong'],
  pinduoduo: ['拼多多', 'pinduoduo', 'pdd'],
  xiaohongshu: ['小红书', 'xiaohongshu', 'rednote'],
  douyin: ['抖音', 'douyin', 'tiktok shop'],
}

function roundConfidence(value: number) { return Math.round(value * 100) / 100 }

function evidence(source: string, start: number, end: number): IntentEvidence {
  return { text: source.slice(start, end), start, end }
}

function allMatches(source: string, pattern: RegExp): MatchRecord[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const regex = new RegExp(pattern.source, flags)
  const result: MatchRecord[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(source))) {
    result.push({ match, evidence: evidence(source, match.index, match.index + match[0].length) })
    if (!match[0].length) regex.lastIndex += 1
  }
  return result
}

function normalizedText(value: string) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function unique(values: readonly string[]) {
  return [...new Set(values.map(normalizedText).filter(Boolean))]
}

function parseMoney(amountText: string, currencyMark: string): NormalizedMoney | undefined {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(amountText)) return undefined
  const amount = Number(amountText)
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const currency = currencyMark === '$' ? 'USD' : 'CNY'
  const minorUnits = Math.round(amount * 100)
  return { currency, amount: (minorUnits / 100).toFixed(2), minorUnits }
}

function sameMoney(left?: NormalizedMoney, right?: NormalizedMoney) {
  return Boolean(left && right && left.currency === right.currency && left.minorUnits === right.minorUnits)
}

function containedBy(candidate: IntentEvidence, containers: readonly IntentEvidence[]) {
  return containers.some(container => candidate.start >= container.start && candidate.end <= container.end)
}

function parseDateToken(value: string): NormalizedDateTime | undefined {
  const normalized = normalizedText(value)
  const numeric = /^(\d{4})(?:-|\/|年)(\d{1,2})(?:-|\/|月)(\d{1,2})(?:日)?(?:[ T](\d{1,2}):(\d{2})(?:\s*(Z|[+-]\d{2}:?\d{2}))?)?$/u.exec(normalized)
  if (numeric) {
    const [, yearText, monthText, dayText, hourText, minuteText, zoneText] = numeric
    const year = Number(yearText); const month = Number(monthText); const day = Number(dayText)
    const hour = hourText === undefined ? undefined : Number(hourText); const minute = minuteText === undefined ? undefined : Number(minuteText)
    const validDay = new Date(Date.UTC(year, month - 1, day)).getUTCFullYear() === year && new Date(Date.UTC(year, month - 1, day)).getUTCMonth() === month - 1 && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day
    if (!validDay || hour !== undefined && (hour > 23 || minute === undefined || minute > 59)) return undefined
    const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (hour === undefined) return { iso: date, precision: 'date' }
    const timezone = zoneText ? zoneText.replace(/([+-]\d{2})(\d{2})$/u, '$1:$2') : undefined
    return { iso: `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${timezone ?? ''}`, precision: 'minute', ...(timezone ? { timezone } : {}) }
  }
  const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 }
  const english = /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})$/iu.exec(normalized)
  if (!english) return undefined
  return parseDateToken(`${english[3]}-${months[english[1]!.toLocaleLowerCase('en-US')]}-${english[2]}`)
}

function dateOrder(value: NormalizedDateTime) {
  const parsed = Date.parse(value.iso.length === 10 ? `${value.iso}T00:00:00Z` : value.iso)
  return Number.isNaN(parsed) ? undefined : parsed
}

function extractLabeledValue(source: string, patterns: readonly RegExp[]) {
  const matches = patterns.flatMap(pattern => allMatches(source, pattern)).sort((left, right) => left.evidence.start - right.evidence.start)
  return matches.map(item => ({ value: normalizedText(item.match[1] ?? ''), evidence: item.evidence })).filter(item => item.value)
}

function issueQuestion(issue: MerchantIntentIssue, index: number): MerchantIntentQuestion {
  return { id: `merchant_intent_${issue.code.toLocaleLowerCase('en-US')}_${index + 1}`, field: issue.field, prompt: issue.message, reason: issue.code, evidence: issue.evidence, ...(issue.candidates ? { candidates: issue.candidates } : {}) }
}

function assignBrandField(
  target: MerchantBrandIntent,
  key: keyof MerchantBrandIntent,
  candidates: Array<{ value: string; evidence: IntentEvidence }>,
  issues: MerchantIntentIssue[],
  transform: (value: string) => string | string[] = value => value,
) {
  if (!candidates.length) return
  const values = unique(candidates.map(candidate => candidate.value))
  if (values.length > 1) {
    issues.push({ code: 'BRAND_VALUE_CONFLICT', field: `brand.${key}`, message: `${String(key)} 出现多个不同值，请确认使用哪一个`, evidence: candidates.map(candidate => candidate.evidence), candidates: values })
    return
  }
  const value = transform(values[0]!)
  const extracted = { value, confidence: 0.98, evidence: candidates.map(candidate => candidate.evidence) }
  Object.assign(target, { [key]: extracted })
}

function extractBrand(source: string, issues: MerchantIntentIssue[]): MerchantBrandIntent {
  const brand: MerchantBrandIntent = {}
  assignBrandField(brand, 'name', extractLabeledValue(source, [/(?:品牌名称|品牌)\s*(?:是|为|[:：])\s*([^\n，,；;。]{1,80})/gu, /\bbrand(?:\s+name)?\s*(?:is|:)\s*([^\n,;.]{1,80})/giu]), issues)
  assignBrandField(brand, 'positioning', extractLabeledValue(source, [/(?:品牌定位|定位)\s*(?:是|为|[:：])\s*([^\n，,；;。]{1,160})/gu, /\b(?:brand\s+)?positioning\s*(?:is|:)\s*([^\n,;.]{1,160})/giu]), issues)
  assignBrandField(brand, 'audience', extractLabeledValue(source, [/(?:目标受众|目标人群|受众)\s*(?:是|为|[:：])\s*([^\n，,；;。]{1,160})/gu, /\b(?:target\s+audience|audience)\s*(?:is|:)\s*([^\n,;.]{1,160})/giu]), issues)
  assignBrandField(brand, 'tone', extractLabeledValue(source, [/(?:品牌语调|品牌调性|语调|调性)\s*(?:是|为|[:：])\s*([^\n；;。]{1,160})/gu, /\b(?:brand\s+)?tone\s*(?:is|:)\s*([^\n;.]{1,160})/giu]), issues, value => unique(value.split(/[,，、/]|\band\b/giu)))
  return brand
}

function extractThresholdReductions(source: string, issues: MerchantIntentIssue[]) {
  const entries: PromotionTier[] = []
  const patterns = [
    /满\s*(\d+(?:\.\d{1,2})?)\s*(元|¥|￥)\s*减\s*(\d+(?:\.\d{1,2})?)\s*(元|¥|￥)/gu,
    /\bspend\s*(\$)\s*(\d+(?:\.\d{1,2})?)\s*(?:and\s*)?(?:save|get)\s*(\$)\s*(\d+(?:\.\d{1,2})?)\s*off\b/giu,
  ]
  patterns.forEach((pattern, patternIndex) => {
    for (const item of allMatches(source, pattern)) {
      const threshold = patternIndex === 0 ? parseMoney(item.match[1]!, item.match[2]!) : parseMoney(item.match[2]!, item.match[1]!)
      const reduction = patternIndex === 0 ? parseMoney(item.match[3]!, item.match[4]!) : parseMoney(item.match[4]!, item.match[3]!)
      if (!threshold || !reduction || threshold.currency !== reduction.currency || reduction.minorUnits >= threshold.minorUnits) {
        issues.push({ code: 'PROMOTION_VALUE_INVALID', field: 'promotion.threshold_reduction', message: `满减金额无效或减免金额不小于门槛：${item.evidence.text}`, evidence: [item.evidence] })
      } else entries.push({ minimumSpend: threshold, reduction, evidence: item.evidence })
    }
  })
  return entries
}

function extractMechanisms(source: string, issues: MerchantIntentIssue[]): PromotionMechanism[] {
  const mechanisms: PromotionMechanism[] = []
  const tiers = extractThresholdReductions(source, issues)
  if (tiers.length === 1) mechanisms.push({ kind: 'threshold_reduction', confidence: 0.99, evidence: [tiers[0]!.evidence], complete: true, minimumSpend: tiers[0]!.minimumSpend, reduction: tiers[0]!.reduction })
  if (tiers.length > 1) {
    const currencies = new Set(tiers.flatMap(tier => [tier.minimumSpend.currency, tier.reduction.currency]))
    const thresholdReductions = new Map<string, Set<number>>()
    for (const tier of tiers) {
      const key = `${tier.minimumSpend.currency}:${tier.minimumSpend.minorUnits}`
      const reductions = thresholdReductions.get(key) ?? new Set<number>()
      reductions.add(tier.reduction.minorUnits); thresholdReductions.set(key, reductions)
    }
    if (currencies.size > 1 || [...thresholdReductions.values()].some(reductions => reductions.size > 1)) issues.push({ code: 'PROMOTION_VALUE_CONFLICT', field: 'promotion.tiered_reduction', message: '阶梯满减包含跨币种或同门槛不同减额，请确认阶梯配置', evidence: tiers.map(tier => tier.evidence) })
    mechanisms.push({ kind: 'tiered_reduction', confidence: 0.99, evidence: tiers.map(tier => tier.evidence), complete: true, tiers })
  }

  for (const item of allMatches(source, /满\s*(\d+)\s*件\s*(\d{1,2}(?:\.\d)?)\s*折/gu)) {
    const quantity = Number(item.match[1]); const rate = Number(item.match[2]) / 10
    if (quantity < 1 || rate <= 0 || rate >= 1) issues.push({ code: 'PROMOTION_VALUE_INVALID', field: 'promotion.quantity_discount', message: `满件折扣数值无效：${item.evidence.text}`, evidence: [item.evidence] })
    else mechanisms.push({ kind: 'quantity_discount', confidence: 0.99, evidence: [item.evidence], complete: true, minimumQuantity: quantity, discountRate: rate })
  }
  for (const item of allMatches(source, /\bbuy\s+(\d+)\s+(?:items?\s+)?(?:and\s+)?get\s+(\d+(?:\.\d+)?)%\s*off\b/giu)) {
    const quantity = Number(item.match[1]); const percent = Number(item.match[2]); const rate = 1 - percent / 100
    if (quantity < 1 || percent <= 0 || percent >= 100) issues.push({ code: 'PROMOTION_VALUE_INVALID', field: 'promotion.quantity_discount', message: `quantity discount is invalid: ${item.evidence.text}`, evidence: [item.evidence] })
    else mechanisms.push({ kind: 'quantity_discount', confidence: 0.98, evidence: [item.evidence], complete: true, minimumQuantity: quantity, discountRate: roundConfidence(rate) })
  }

  for (const item of allMatches(source, /满\s*(\d+)\s*件\s*(?:赠|送)\s*([^，,；;。\n]{1,100})/gu)) mechanisms.push({ kind: 'gift', confidence: 0.97, evidence: [item.evidence], complete: true, minimumQuantity: Number(item.match[1]), giftDescription: normalizedText(item.match[2]!) })
  for (const item of allMatches(source, /\b(?:buy|purchase)\s+(\d+)\s+(?:items?\s+)?(?:and\s+)?(?:get|receive)\s+(?:a\s+)?free\s+([^,;.\n]{1,100})/giu)) mechanisms.push({ kind: 'gift', confidence: 0.96, evidence: [item.evidence], complete: true, minimumQuantity: Number(item.match[1]), giftDescription: normalizedText(item.match[2]!) })

  const thresholdCouponRanges = allMatches(source, /满\s*(\d+(?:\.\d{1,2})?)\s*(元|¥|￥)\s*可用(?:的)?\s*(\d+(?:\.\d{1,2})?)\s*(元|¥|￥)\s*(?:优惠)?券/gu)
  for (const item of thresholdCouponRanges) {
    const minimumSpend = parseMoney(item.match[1]!, item.match[2]!); const couponAmount = parseMoney(item.match[3]!, item.match[4]!)
    if (!minimumSpend || !couponAmount || minimumSpend.currency !== couponAmount.currency || couponAmount.minorUnits >= minimumSpend.minorUnits) issues.push({ code: 'PROMOTION_VALUE_INVALID', field: 'promotion.coupon', message: `优惠券金额或门槛无效：${item.evidence.text}`, evidence: [item.evidence] })
    else mechanisms.push({ kind: 'coupon', confidence: 0.99, evidence: [item.evidence], complete: true, minimumSpend, couponAmount })
  }
  for (const item of allMatches(source, /(\d+(?:\.\d{1,2})?)\s*(元|¥|￥)\s*(?:无门槛)?(?:优惠)?券/gu)) {
    if (containedBy(item.evidence, thresholdCouponRanges.map(range => range.evidence))) continue
    const couponAmount = parseMoney(item.match[1]!, item.match[2]!)
    if (couponAmount) mechanisms.push({ kind: 'coupon', confidence: 0.96, evidence: [item.evidence], complete: true, couponAmount })
  }
  for (const item of allMatches(source, /(?:coupon|voucher)\s*(?:of|:)??\s*(\$)\s*(\d+(?:\.\d{1,2})?)/giu)) {
    const couponAmount = parseMoney(item.match[2]!, item.match[1]!)
    if (couponAmount) mechanisms.push({ kind: 'coupon', confidence: 0.96, evidence: [item.evidence], complete: true, couponAmount })
  }

  const presalePatterns = [
    /(?:预售[：:]?\s*)?定金\s*(\d+(?:\.\d{1,2})?)\s*(元|¥|￥)[，,、\s]*(?:尾款|余款)\s*(\d+(?:\.\d{1,2})?)\s*(元|¥|￥)/gu,
    /\bdeposit\s*(\$)\s*(\d+(?:\.\d{1,2})?)[,;\s]+(?:balance|final payment)\s*(\$)\s*(\d+(?:\.\d{1,2})?)/giu,
  ]
  const completePresaleEvidence: IntentEvidence[] = []
  presalePatterns.forEach((pattern, index) => {
    for (const item of allMatches(source, pattern)) {
      const deposit = index === 0 ? parseMoney(item.match[1]!, item.match[2]!) : parseMoney(item.match[2]!, item.match[1]!)
      const balance = index === 0 ? parseMoney(item.match[3]!, item.match[4]!) : parseMoney(item.match[4]!, item.match[3]!)
      if (!deposit || !balance || deposit.currency !== balance.currency) issues.push({ code: 'PROMOTION_VALUE_INVALID', field: 'promotion.presale', message: `预售定金/尾款金额无效：${item.evidence.text}`, evidence: [item.evidence] })
      else { mechanisms.push({ kind: 'presale', confidence: 0.99, evidence: [item.evidence], complete: true, deposit, balance }); completePresaleEvidence.push(item.evidence) }
    }
  })

  for (const item of allMatches(source, /(?:定金\s*\d+(?:\.\d{1,2})?\s*(?:元|¥|￥)|\bdeposit\s*[$¥￥]\s*\d+(?:\.\d{1,2})?)/giu)) if (!containedBy(item.evidence, completePresaleEvidence)) issues.push({ code: 'PROMOTION_EXPRESSION_INCOMPLETE', field: 'promotion.presale.balance', message: '已识别定金，但缺少完整尾款金额和币种', evidence: [item.evidence] })
  for (const item of allMatches(source, /(?:(?:尾款|余款)\s*\d+(?:\.\d{1,2})?\s*(?:元|¥|￥)|\b(?:balance|final payment)\s*[$¥￥]\s*\d+(?:\.\d{1,2})?)/giu)) if (!containedBy(item.evidence, completePresaleEvidence)) issues.push({ code: 'PROMOTION_EXPRESSION_INCOMPLETE', field: 'promotion.presale.deposit', message: '已识别尾款，但缺少完整定金金额和币种', evidence: [item.evidence] })

  for (const item of allMatches(source, /会员价\s*(\d+(?:\.\d{1,2})?)\s*(元|¥|￥)/gu)) {
    const memberPrice = parseMoney(item.match[1]!, item.match[2]!)
    if (memberPrice) mechanisms.push({ kind: 'member_price', confidence: 0.99, evidence: [item.evidence], complete: true, memberPrice })
  }
  for (const item of allMatches(source, /\bmember\s+price\s*(?:is|:)?\s*([$¥￥])\s*(\d+(?:\.\d{1,2})?)/giu)) {
    const memberPrice = parseMoney(item.match[2]!, item.match[1]!)
    if (memberPrice) mechanisms.push({ kind: 'member_price', confidence: 0.99, evidence: [item.evidence], complete: true, memberPrice })
  }

  const incompletePatterns: Array<{ pattern: RegExp; field: string; prompt: string }> = [
    { pattern: /满\s*\d+(?:\.\d+)?\s*(?:元|件)?\s*(?:减|赠|送|打折)\s*(?=$|[，,；;。\n])/gu, field: 'promotion', prompt: '促销表达不完整，请补充减免金额、折扣或赠品内容' },
    { pattern: /满\s*\d+\s*件\s*折\s*(?=$|[，,；;。\n])/gu, field: 'promotion.quantity_discount', prompt: '请补充满件折扣值，例如 8 折' },
    { pattern: /满\s*\d+(?:\.\d{1,2})?\s*(?:元|¥|￥)\s*可用(?:的)?\s*(?:优惠)?券\s*(?=$|[，,；;。\n])/gu, field: 'promotion.coupon', prompt: '请补充优惠券金额' },
    { pattern: /\b(?:coupon|voucher)\s*(?:is|:)?\s*\d+(?:\.\d{1,2})?\s*(?=$|[,;.\n])/giu, field: 'promotion.coupon', prompt: '请补充优惠券币种' },
    { pattern: /(?:定金|deposit)\s*(?:[:：])?\s*(?=$|[，,；;。\n])/giu, field: 'promotion.presale.deposit', prompt: '请补充预售定金金额和币种' },
    { pattern: /(?:尾款|余款|balance|final payment)\s*(?:[:：])?\s*(?=$|[，,；;。\n])/giu, field: 'promotion.presale.balance', prompt: '请补充预售尾款金额和币种' },
    { pattern: /(?:会员价|member price)\s*(?:[:：])?\s*(?=$|[，,；;。\n])/giu, field: 'promotion.member_price', prompt: '请补充会员价金额和币种' },
    { pattern: /(?:会员价|member price)\s*(?:is|[:：])?\s*\d+(?:\.\d{1,2})?\s*(?=$|[，,；;。\n])/giu, field: 'promotion.member_price', prompt: '请补充会员价币种' },
  ]
  for (const entry of incompletePatterns) for (const item of allMatches(source, entry.pattern)) issues.push({ code: 'PROMOTION_EXPRESSION_INCOMPLETE', field: entry.field, message: entry.prompt, evidence: [item.evidence] })

  const memberPrices = mechanisms.filter(item => item.kind === 'member_price')
  if (memberPrices.length > 1 && memberPrices.some(item => !sameMoney(item.memberPrice, memberPrices[0]!.memberPrice))) issues.push({ code: 'PROMOTION_VALUE_CONFLICT', field: 'promotion.member_price', message: '检测到多个不同会员价，请确认最终会员价', evidence: memberPrices.flatMap(item => item.evidence), candidates: memberPrices.map(item => `${item.memberPrice!.currency} ${item.memberPrice!.amount}`) })
  const presales = mechanisms.filter(item => item.kind === 'presale')
  if (presales.length > 1 && presales.some(item => !sameMoney(item.deposit, presales[0]!.deposit) || !sameMoney(item.balance, presales[0]!.balance))) issues.push({ code: 'PROMOTION_VALUE_CONFLICT', field: 'promotion.presale', message: '检测到多组不同的定金/尾款，请确认预售金额', evidence: presales.flatMap(item => item.evidence) })
  return mechanisms
}

function extractValidity(source: string, issues: MerchantIntentIssue[]): ExtractedIntentValue<PromotionValidity> | undefined {
  const dateToken = '(?:\\d{4}(?:-|/|年)\\d{1,2}(?:-|/|月)\\d{1,2}(?:日)?(?:[ T]\\d{1,2}:\\d{2}(?:\\s*(?:Z|[+-]\\d{2}:?\\d{2}))?)?|(?:january|february|march|april|may|june|july|august|september|october|november|december)\\s+\\d{1,2},?\\s+\\d{4})'
  const pattern = new RegExp(`(?:有效期|活动时间|promotion period|validity)?\\s*(?:从|自|from)?\\s*(${dateToken})\\s*(?:至|到|—|–|~|to|through)\\s*(${dateToken})`, 'giu')
  const ranges = allMatches(source, pattern).map(item => ({ start: parseDateToken(item.match[1]!), end: parseDateToken(item.match[2]!), evidence: item.evidence }))
  if (!ranges.length) {
    for (const item of allMatches(source, /(?:有效期|活动时间)?\s*(?:从|自)?\s*\d{1,2}月\d{1,2}日?\s*(?:至|到|—|–|~)\s*\d{1,2}月\d{1,2}日?/gu)) issues.push({ code: 'DATE_RANGE_INVALID', field: 'promotion.validity', message: '活动时间缺少年份，不能推断具体日期', evidence: [item.evidence] })
  }
  const valid = ranges.filter((range): range is { start: NormalizedDateTime; end: NormalizedDateTime; evidence: IntentEvidence } => Boolean(range.start && range.end))
  ranges.filter(range => !range.start || !range.end).forEach(range => issues.push({ code: 'DATE_RANGE_INVALID', field: 'promotion.validity', message: `活动时间无法安全解析：${range.evidence.text}`, evidence: [range.evidence] }))
  valid.filter(range => dateOrder(range.start)! >= dateOrder(range.end)!).forEach(range => issues.push({ code: 'DATE_RANGE_INVALID', field: 'promotion.validity', message: '活动结束时间必须晚于开始时间', evidence: [range.evidence] }))
  const ordered = valid.filter(range => dateOrder(range.start)! < dateOrder(range.end)!)
  const identities = unique(ordered.map(range => `${range.start.iso}/${range.end.iso}`))
  if (identities.length > 1) {
    issues.push({ code: 'DATE_RANGE_CONFLICT', field: 'promotion.validity', message: '检测到多个不同活动时间窗，请确认最终时间', evidence: ordered.map(range => range.evidence), candidates: identities })
    return undefined
  }
  if (!ordered.length) return undefined
  return { value: { start: ordered[0]!.start, end: ordered[0]!.end }, confidence: 0.99, evidence: ordered.map(range => range.evidence) }
}

function extractPlatforms(source: string, aliases: MerchantIntentExtractorOptions['platformAliases']): ExtractedIntentValue<string[]> | undefined {
  const dictionary = { ...DEFAULT_PLATFORM_ALIASES, ...(aliases ?? {}) }
  const found: Array<{ platform: string; evidence: IntentEvidence }> = []
  for (const [platform, names] of Object.entries(dictionary)) for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const latin = /^[a-z0-9 ]+$/iu.test(name)
    const pattern = new RegExp(latin ? `\\b${escaped}\\b` : escaped, 'giu')
    for (const item of allMatches(source, pattern)) found.push({ platform, evidence: item.evidence })
  }
  if (!found.length) return undefined
  return { value: [...new Set(found.map(item => item.platform))], confidence: 0.97, evidence: found.map(item => item.evidence) }
}

function extractProducts(source: string): ExtractedIntentValue<string[]> | undefined {
  const matches = extractLabeledValue(source, [/(?:适用商品|商品范围|仅限商品)\s*[:：]\s*([^\n；;。]{1,240})/gu, /\b(?:applicable products?|product scope|products?)\s*:\s*([^\n;.]{1,240})/giu])
  if (!matches.length) return undefined
  const products = unique(matches.flatMap(item => item.value.split(/[,，、/]|\band\b/giu)))
  return products.length ? { value: products, confidence: 0.98, evidence: matches.map(item => item.evidence) } : undefined
}

export function extractMerchantIntent(sourceText: string, options: MerchantIntentExtractorOptions = {}): MerchantIntentExtraction {
  if (typeof sourceText !== 'string') throw new TypeError('MERCHANT_INTENT_TEXT_REQUIRED')
  const ambiguities: MerchantIntentIssue[] = []
  const brand = extractBrand(sourceText, ambiguities)
  const mechanisms = extractMechanisms(sourceText, ambiguities)
  const validity = extractValidity(sourceText, ambiguities)
  const platforms = extractPlatforms(sourceText, options.platformAliases)
  const products = extractProducts(sourceText)
  const promotion: MerchantPromotionIntent = { mechanisms, ...(validity ? { validity } : {}), ...(platforms ? { platforms } : {}), ...(products ? { products } : {}) }
  const questions = ambiguities.map(issueQuestion)
  return { sourceText, brand, promotion, ambiguities, questions, safeToApply: ambiguities.length === 0 && mechanisms.every(mechanism => mechanism.complete) }
}
