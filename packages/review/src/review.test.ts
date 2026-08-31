import { describe, expect, it } from 'vitest'
import { buildReviewReport, isReviewBlocking, reviewDeterministic, reviewProductImages, REVIEW_EVIDENCE_BOUNDARY } from './review.js'
import { defaultRuleCenterSeeds, RuleCenter } from './rule-center.js'

describe('deterministic content review', () => {
  const base = { body: { title: '轻量外套', detail: '通勤可穿', sellingPoints: ['轻便'] }, facts: { skuIds: ['sku-1'], price: 100, minPrice: 80, maxPrice: 120, sourceIds: ['fact-1'] }, referencedSkuIds: ['sku-1'], ruleVersionIds: ['rule-1'] }

  it('passes sourced content within price and SKU constraints', () => {
    expect(reviewDeterministic(base)).toEqual([])
    expect(isReviewBlocking([])).toBe(false)
  })

  it('ships independent platform rule seeds for all six launch platforms', () => {
    const platformSeeds = defaultRuleCenterSeeds.filter(seed => seed.scope === 'platform')
    expect(platformSeeds.map(seed => seed.packId)).toEqual(expect.arrayContaining(['jd-write', 'taobao-mapping', 'tmall-mapping', 'pinduoduo-mapping', 'xiaohongshu-content', 'douyin-content']))
    expect(platformSeeds.map(seed => seed.targetId)).toEqual(expect.arrayContaining(['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']))
    expect(new Set(platformSeeds.map(seed => seed.source.kind))).toEqual(new Set(['official', 'internal']))
    expect(platformSeeds.every(seed => seed.status === 'active' && seed.source.reference && seed.source.checkedAt)).toBe(true)
  })

  it('blocks an SKU without a confirmed image mapping and returns rule hits in reports', () => {
    const findings = reviewDeterministic({ ...base, skuImageMappings: [{ skuId: 'sku-1', imageCount: 0, sourceIds: ['sku:sku-1'] }] })
    expect(findings).toContainEqual(expect.objectContaining({ code: 'SKU_IMAGE_MAPPING_INVALID', field: 'sku.sku-1.images', priority: 'P0' }))
    const report = buildReviewReport(findings, { brandProfileBound: true, visualBriefChecked: true, technicalSchemaChecked: true, platformMappingChecked: true, ruleHits: [{ ruleVersionId: 'rule-1', version: '1.0.0', scope: 'global', action: 'block', severity: 'error', matchedChecks: ['forbiddenTerms'] }] })
    expect(report.ruleHits).toHaveLength(1)
  })

  it('emits explainable findings for all remaining review categories', () => {
    const findings = reviewDeterministic({
      ...base,
      productFactsConfirmed: false,
      checkVisualBrief: true,
      technical: { schemaValid: false, exportManifestPresent: false },
      platformPreflight: { status: 'blocked', reasons: ['账号未完成真实平台 canary'], sourceIds: ['mapping:taobao.v1'] },
    })
    expect(findings.map(item => item.code)).toEqual(expect.arrayContaining(['PRODUCT_FACTS_UNCONFIRMED', 'VISUAL_BRIEF_MISSING', 'TECHNICAL_SCHEMA_INVALID', 'TECHNICAL_EXPORT_MANIFEST_MISSING', 'PLATFORM_PREFLIGHT_PENDING']))
    expect(findings.find(item => item.code === 'PLATFORM_PREFLIGHT_PENDING')).toMatchObject({ priority: 'P0', field: 'platform.preflight', evidence: { sourceIds: ['mapping:taobao.v1'] } })
  })

  it('rechecks promotion expiry and scope at review time', () => {
    const findings = reviewDeterministic({
      ...base,
      promotions: [{ platform: 'taobao', productId: 'product-1', skuIds: ['sku-1'], validTo: '2026-01-01T00:00:00.000Z', sourceId: 'promotion:1' }],
      promotionContext: { platform: 'jd', productId: 'product-1', skuIds: ['sku-2'] },
    })
    expect(findings.map(item => item.code)).toEqual(expect.arrayContaining(['PROMOTION_EXPIRED', 'PROMOTION_SCOPE_INVALID', 'PROMOTION_SKU_UNREFERENCED']))
    expect(findings.filter(item => item.field.startsWith('promotion'))).toHaveLength(3)
  })

  it('blocks missing sources, rules, price range, SKU and forbidden terms', () => {
    const findings = reviewDeterministic({ ...base, facts: { ...base.facts, price: 200, sourceIds: [] }, referencedSkuIds: ['unknown'], ruleVersionIds: [], forbiddenTerms: ['最强'] , body: { ...base.body, title: '全网最强外套' } })
    expect(findings.map(finding => finding.code)).toEqual(expect.arrayContaining(['MISSING_SOURCE', 'MISSING_RULE_VERSION', 'PRICE_NOT_ALLOWED', 'SKU_MISMATCH', 'FORBIDDEN_TERM']))
    expect(isReviewBlocking(findings)).toBe(true)
  })

  it('reports brand forbidden terms as P0 brand evidence', () => {
    const findings = reviewDeterministic({ ...base, body: { ...base.body, title: '云朵顶级外套' }, forbiddenTerms: ['级'], brand: { forbiddenTerms: ['顶级'], sourceIds: ['brand:brand_ws:r3'] } })
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'BRAND_FORBIDDEN_TERM',
      priority: 'P0',
      field: 'content',
      evidence: expect.objectContaining({ kind: 'brand', sourceIds: ['brand:brand_ws:r3'] }),
    }))
    expect(findings.filter(item => item.field === 'content')).toHaveLength(1)
    const report = buildReviewReport(findings, { brandProfileBound: true, visualBriefChecked: true, technicalSchemaChecked: true, platformMappingChecked: true })
    expect(report.categories.find(category => category.id === 'brand_consistency')).toMatchObject({ status: 'blocking', findingCount: 1 })
  })

  it('keeps rule versions immutable and records publish/status audit events', () => {
    let tick = 0
    const center = new RuleCenter(() => `2026-08-23T00:00:0${tick++}.000Z`)
    const first = center.publish({
      packId: 'catalog', name: '商品规则', version: 'catalog-1.0.0', scope: 'category', actorId: 'rules-owner',
      source: { kind: 'internal', reference: 'ticket://RULE-1', checkedAt: '2026-08-23T00:00:00.000Z' },
      checks: { forbiddenTerms: ['极致'] }, reason: '首个可审计版本',
    })
    expect(first.status).toBe('draft')
    expect(first.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(() => center.publish({
      packId: 'catalog', name: '商品规则', version: 'catalog-1.0.0', scope: 'category', actorId: 'rules-owner',
      source: { kind: 'internal', reference: 'ticket://RULE-1', checkedAt: '2026-08-23T00:00:00.000Z' },
    })).toThrow('RULE_VERSION_DUPLICATE')

    const active = center.setStatus({ packId: 'catalog', version: 'catalog-1.0.0', status: 'active', actorId: 'rules-owner', reason: '完成复核并启用' })
    expect(active.status).toBe('active')
    expect(center.activeVersionIds()).toEqual(['catalog-1.0.0'])
    expect(center.activeChecks().forbiddenTerms).toEqual(['极致'])
    expect(center.history('catalog')).toHaveLength(1)
    expect(center.audit('catalog').map(event => event.action)).toEqual(['created', 'activated'])

    const second = center.publish({
      packId: 'catalog', name: '商品规则', version: 'catalog-2.0.0', scope: 'category', actorId: 'rules-owner',
      source: { kind: 'internal', reference: 'ticket://RULE-2', checkedAt: '2026-08-23T00:01:00.000Z' },
      checks: { forbiddenTerms: ['极致', '全网第一'] }, reason: '更新规则来源',
    })
    center.setStatus({ packId: 'catalog', version: second.version, status: 'active', actorId: 'rules-owner', reason: '新版本生效' })
    expect(center.get('catalog').version).toBe('catalog-2.0.0')
    expect(center.history('catalog').map(item => item.status)).toEqual(['inactive', 'active'])
    expect(center.audit('catalog').map(event => event.action)).toEqual(['created', 'activated', 'created', 'deactivated', 'activated'])
  })

  it('fails closed when a content version references an unavailable rule version', () => {
    const findings = reviewDeterministic({
      body: { title: '商品', detail: '详情', sellingPoints: [] },
      facts: { skuIds: [], sourceIds: ['fact-1'] }, referencedSkuIds: [],
      ruleVersionIds: ['catalog-0.9.0'], availableRuleVersionIds: ['catalog-1.0.0'],
    })
    expect(findings).toContainEqual(expect.objectContaining({ code: 'MISSING_RULE_VERSION', severity: 'error' }))
    expect(isReviewBlocking(findings)).toBe(true)
  })

  it('blocks a module that has no fact provenance even when the version has sources', () => {
    const findings = reviewDeterministic({ ...base, modules: [{ key: 'specifications', factSourceIds: [] }] })
    expect(findings).toContainEqual(expect.objectContaining({ code: 'MISSING_SOURCE', field: 'modules.specifications', severity: 'error' }))
  })

  it('normalizes priority, remediation, status and local evidence boundary on every finding', () => {
    const findings = reviewDeterministic({ ...base, facts: { ...base.facts, sourceIds: [] }, forbiddenTerms: ['最强'], body: { ...base.body, title: '全网最强外套' } })
    expect(findings.length).toBeGreaterThan(0)
    for (const item of findings) {
      expect(item.priority).toMatch(/^P[012]$/)
      expect(item.status).toBe('open')
      expect(item.repairSuggestion).not.toBe('')
      expect(item.evidence).toMatchObject({ scope: 'local_deterministic', externalVerification: 'not_performed', boundary: REVIEW_EVIDENCE_BOUNDARY, verified: true })
    }
  })

  it('uses P2 for a non-blocking duplicate image finding', () => {
    const findings = reviewProductImages(['https://cdn.example.com/main.jpg', 'https://cdn.example.com/main.jpg'])
    expect(findings).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_IMAGE', severity: 'warning', priority: 'P2', status: 'open' }))
    expect(isReviewBlocking(findings)).toBe(false)
  })

  it('reports all six PRD review categories without claiming external checks passed', () => {
    const report = buildReviewReport([], { brandProfileBound: false, visualBriefChecked: true, technicalSchemaChecked: true, platformMappingChecked: true })
    expect(report.categories.map(category => category.id)).toEqual(['product_truth', 'brand_consistency', 'copy_price_compliance', 'visual_brief_quality', 'technical_specification', 'platform_preflight'])
    expect(report.categories.find(category => category.id === 'brand_consistency')?.status).toBe('not_evaluated')
    expect(report.categories.find(category => category.id === 'platform_preflight')?.status).toBe('external_pending')
    expect(report.blocking).toBe(false)
  })

  it('shows handled review suggestions without presenting them as a clean pass', () => {
    const finding = reviewProductImages(['https://example.com/a.jpg', 'https://example.com/a.jpg'])[0]!
    const report = buildReviewReport([{ ...finding, status: 'waived', decision: { reason: '内部对比图', actorId: 'merchant', updatedAt: '2026-08-25T00:00:00.000Z' } }], { brandProfileBound: false, visualBriefChecked: true, technicalSchemaChecked: true, platformMappingChecked: true })
    expect(report.categories.find(category => category.id === 'visual_brief_quality')).toMatchObject({ status: 'warning', summary: '1 项改进建议，均已处理并保留审计记录' })
  })

  it('evaluates scoped rules from global to campaign and merges their checks', () => {
    const source = { kind: 'internal' as const, reference: 'ticket://RULE-SCOPE', checkedAt: '2026-08-23T00:00:00.000Z' }
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [
      { packId: 'campaign-rule', name: '活动规则', version: '1', scope: 'campaign', targetId: 'summer', status: 'active', source, checks: { forbiddenTerms: ['活动第一'] } },
      { packId: 'global-rule', name: '全局规则', version: '1', scope: 'global', status: 'active', source, checks: { forbiddenTerms: ['绝对化'] } },
      { packId: 'store-rule', name: '店铺规则', version: '1', scope: 'store', targetId: 'store-1', status: 'active', source, checks: { requiredFields: ['brand'] } },
      { packId: 'platform-rule', name: '平台规则', version: '1', scope: 'platform', targetId: 'taobao', status: 'active', source, checks: { forbiddenTerms: ['全网最低'] } },
    ])
    const result = center.evaluate({ platform: 'taobao', store: 'store-1', campaign: 'summer' }, '2026-08-24T12:00:00.000Z')
    expect(result.applicable.map(rule => rule.scope)).toEqual(['global', 'platform', 'store', 'campaign'])
    expect(result.checks.forbiddenTerms).toEqual(['绝对化', '全网最低', '活动第一'])
    expect(result.checks.requiredFields).toEqual(['brand'])
    expect(result.findings).toEqual([])
  })

  it('returns an explainable blocking finding for a matched expired rule', () => {
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [{
      packId: 'expired-platform', name: '过期平台规则', version: '1', scope: 'platform', targetId: 'taobao', status: 'active',
      effectiveTo: '2026-08-24T11:00:00.000Z', source: { kind: 'official', reference: 'manual://expired', checkedAt: '2026-08-20T00:00:00.000Z' },
    }])
    const result = center.evaluate({ platform: 'taobao' }, '2026-08-24T12:00:00.000Z')
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'RULE_EXPIRED', severity: 'error', action: 'block', ruleVersionId: 'expired-platform@1' }))
    expect(result.findings[0]?.message).toContain('已于 2026-08-24T11:00:00.000Z 过期')
    expect(isReviewBlocking(reviewDeterministic({ ...base, ruleCenter: center, ruleContext: { platform: 'taobao' }, reviewAt: '2026-08-24T12:00:00.000Z' }))).toBe(true)
  })

  it('uses advisory expiry configuration outside platform scope without blocking review', () => {
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [{
      packId: 'advisory-brand', name: '品牌建议规则', version: '1', scope: 'brand', targetId: 'brand-1', status: 'active',
      effectiveTo: '2026-08-24T11:00:00.000Z', severity: 'warning', action: 'warn', checks: { conflictKeys: ['visual-density'] },
      source: { kind: 'internal', reference: 'manual://advisory-expired', checkedAt: '2026-08-20T00:00:00.000Z' },
    }])
    const result = center.evaluate({ brand: 'brand-1' }, '2026-08-24T12:00:00.000Z')
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'RULE_EXPIRED', severity: 'warning', action: 'warn' }))
    expect(isReviewBlocking(reviewDeterministic({ ...base, ruleCenter: center, ruleContext: { brand: 'brand-1' }, reviewAt: '2026-08-24T12:00:00.000Z' }))).toBe(false)
  })

  it('keeps expired platform rules P0 fail-closed even when configured as advisory', () => {
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [{
      packId: 'advisory-platform', name: '平台建议规则', version: '1', scope: 'platform', targetId: 'taobao', status: 'active',
      effectiveTo: '2026-08-24T11:00:00.000Z', severity: 'warning', action: 'allow',
      source: { kind: 'official', reference: 'manual://platform-expired', checkedAt: '2026-08-20T00:00:00.000Z' },
    }])
    const result = center.evaluate({ platform: 'taobao' }, '2026-08-24T12:00:00.000Z')
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'RULE_EXPIRED', severity: 'error', action: 'block' }))
    expect(isReviewBlocking(reviewDeterministic({ ...base, ruleCenter: center, ruleContext: { platform: 'taobao' }, reviewAt: '2026-08-24T12:00:00.000Z' }))).toBe(true)
  })

  it('uses advisory policy for a rule explicitly transitioned to expired', () => {
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [{
      packId: 'expired-advisory', name: '已撤销建议规则', version: '1', scope: 'campaign', targetId: 'summer', status: 'active',
      severity: 'warning', action: 'review', source: { kind: 'internal', reference: 'manual://expired-advisory', checkedAt: '2026-08-20T00:00:00.000Z' },
    }])
    center.setStatus({ packId: 'expired-advisory', status: 'expired', actorId: 'rules-owner', reason: '建议规则待复核' })
    expect(center.evaluate({ campaign: 'summer' }).findings).toContainEqual(expect.objectContaining({ code: 'RULE_EXPIRED', severity: 'warning', action: 'review' }))
  })

  it('does not downgrade expiry when either configured policy is blocking', () => {
    const source = { kind: 'internal' as const, reference: 'manual://blocking-expiry', checkedAt: '2026-08-20T00:00:00.000Z' }
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [
      { packId: 'warning-block', name: '阻断动作', version: '1', scope: 'brand', targetId: 'brand-1', status: 'active', effectiveTo: '2026-08-24T11:00:00.000Z', severity: 'warning', action: 'block', source },
      { packId: 'error-review', name: '错误级别', version: '1', scope: 'brand', targetId: 'brand-1', status: 'active', effectiveTo: '2026-08-24T11:00:00.000Z', severity: 'error', action: 'review', source },
    ])
    expect(center.evaluate({ brand: 'brand-1' }).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleVersionId: 'warning-block@1', severity: 'error', action: 'block' }),
      expect.objectContaining({ ruleVersionId: 'error-review@1', severity: 'error', action: 'block' }),
    ]))
  })

  it('does not allow a lower-scope allow rule to override the same normalized blocked term', () => {
    const source = { kind: 'official' as const, reference: 'manual://priority', checkedAt: '2026-08-23T00:00:00.000Z' }
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [
      { packId: 'legal-hard', name: '法律硬规则', version: '1', scope: 'global', status: 'active', source, action: 'block', checks: { forbiddenTerms: ['SALE\u3000PRICE'] } },
      { packId: 'campaign-exception', name: '活动例外', version: '1', scope: 'campaign', targetId: 'summer', status: 'active', source, action: 'allow', checks: { forbiddenTerms: [' sale price '] } },
    ])
    const finding = center.evaluate({ campaign: 'summer' }).findings.find(item => item.code === 'RULE_PRIORITY_CONFLICT')
    expect(finding).toMatchObject({ ruleVersionId: 'campaign-exception@1', severity: 'error', action: 'block' })
    expect(finding?.message).toContain('term:sale price')
  })

  it('does not report priority conflicts for unrelated or cross-domain keys', () => {
    const source = { kind: 'official' as const, reference: 'manual://precise-priority', checkedAt: '2026-08-23T00:00:00.000Z' }
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [
      { packId: 'term-hard', name: '词规则', version: '1', scope: 'global', status: 'active', source, action: 'block', checks: { forbiddenTerms: ['最低价'], conflictKeys: ['price-claim'] } },
      { packId: 'unrelated-allow', name: '无关活动例外', version: '1', scope: 'campaign', targetId: 'summer', status: 'active', source, action: 'allow', checks: { forbiddenTerms: ['新品'], requiredFields: ['最低价'], conflictKeys: ['stock-display'] } },
    ])
    expect(center.evaluate({ campaign: 'summer' }).findings.filter(item => item.code === 'RULE_PRIORITY_CONFLICT')).toEqual([])
  })

  it('supports normalized field and explicit conflict keys', () => {
    const source = { kind: 'internal' as const, reference: 'manual://key-priority', checkedAt: '2026-08-23T00:00:00.000Z' }
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [
      { packId: 'field-hard', name: '字段硬规则', version: '1', scope: 'global', status: 'active', source, action: 'block', checks: { requiredFields: [' Product.Title '], conflictKeys: ['PRICE\u3000CLAIM'] } },
      { packId: 'store-allow', name: '店铺例外', version: '1', scope: 'store', targetId: 'store-1', status: 'active', source, action: 'allow', checks: { requiredFields: ['product.title'], conflictKeys: ['price claim'] } },
    ])
    const conflicts = center.evaluate({ store: 'store-1' }).findings.filter(item => item.code === 'RULE_PRIORITY_CONFLICT')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.message).toContain('conflict:price claim')
    expect(conflicts[0]?.message).toContain('field:product.title')
  })

  it('also reports a rule explicitly transitioned to expired', () => {
    const center = new RuleCenter(() => '2026-08-24T12:00:00.000Z', [{
      packId: 'expired-status', name: '状态过期规则', version: '1', scope: 'global', status: 'active',
      source: { kind: 'internal', reference: 'manual://expired-status', checkedAt: '2026-08-20T00:00:00.000Z' },
    }])
    center.setStatus({ packId: 'expired-status', status: 'expired', actorId: 'rules-owner', reason: '平台规则已替换' })
    expect(center.evaluate({}, '2026-08-24T12:00:00.000Z').findings).toContainEqual(expect.objectContaining({ code: 'RULE_EXPIRED', severity: 'error' }))
  })
})
