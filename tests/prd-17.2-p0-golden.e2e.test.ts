import { afterAll, describe, expect, it } from 'vitest'
import { MerchantService } from '../packages/application/src/service.js'
import { PRD_17_2_P0_GOLDEN_FIXTURES, type P0GoldenFixture } from './fixtures/prd-17.2-p0-golden.js'

type GoldenObservation = {
  id: string
  name: string
  expectation: string
  expectedP0: number
  detectedP0: number
  missedP0: number
  signals: string[]
}

const fixtures = new Map<string, P0GoldenFixture>(PRD_17_2_P0_GOLDEN_FIXTURES.map(fixture => [fixture.id, fixture]))
const observations: GoldenObservation[] = []

function fixture(id: string) {
  const value = fixtures.get(id)
  if (!value) throw new Error(`Unknown PRD 17.2 fixture: ${id}`)
  return value
}

function observe(id: string, signals: string[] = []) {
  const scenario = fixture(id)
  const expected = new Set<string>(scenario.expectedP0Signals)
  const detectedP0 = [...expected].filter(signal => signals.includes(signal)).length
  const result: GoldenObservation = {
    id: scenario.id,
    name: scenario.name,
    expectation: scenario.expectation,
    expectedP0: expected.size,
    detectedP0,
    missedP0: expected.size - detectedP0,
    signals,
  }
  observations.push(result)
  expect(result.expectation, `${scenario.name} 必须明确声明 P0 期望`).toMatch(/^P0 期望：/u)
  expect(result.missedP0, `${scenario.name} P0 漏检`).toBe(0)
  return result
}

function captureCode(action: () => unknown) {
  try {
    action()
  } catch (error) {
    const code = (error as { code?: unknown }).code
    expect(typeof code).toBe('string')
    return String(code)
  }
  throw new Error('期望真实服务边界阻断，但操作成功了')
}

function serviceAndProduct(input: {
  workspaceId: string
  title: string
  price?: number
  stock?: number
  skus?: Array<{ id: string; name: string; price: number; stock: number }>
  sellingPoints?: Array<{ id: string; text: string; proofStatus: 'pending' | 'confirmed' | 'rejected'; sourceIds: string[] }>
}) {
  const service = new MerchantService({ fixtureMode: true, seedFixture: false })
  const product = service.importProduct({
    workspaceId: input.workspaceId,
    platform: 'taobao',
    title: input.title,
    stock: input.stock ?? 10,
    ...(input.price === undefined ? {} : { price: input.price }),
    ...(input.skus ? { skus: input.skus } : {}),
    ...(input.sellingPoints ? { sellingPoints: input.sellingPoints } : {}),
  })
  return { service, product }
}

function approvedDetail(input: {
  workspaceId: string
  title: string
  price?: number
  skus?: Array<{ id: string; name: string; price: number; stock: number }>
  answers?: Record<string, string | number | boolean | string[]>
  priceImpactConfirmed?: boolean
}) {
  const { service, product } = serviceAndProduct(input)
  service.confirmProductFacts(input.workspaceId, product.id)
  const task = service.createTask({ workspaceId: input.workspaceId, productId: product.id, platform: 'taobao', requestText: '商品详情页' })
  if (input.answers) service.answerTask(input.workspaceId, task.id, input.answers)
  service.selectDirection(task.id, 'A')
  service.confirmProductionPlan(input.workspaceId, task.id, 'golden-gate', undefined, input.priceImpactConfirmed)
  const version = service.createDraft(task.id)
  const findings = service.reviewContent(input.workspaceId, version.id)
  expect(findings.filter(item => item.priority === 'P0'), `${input.title} 不应产生 P0`).toEqual([])
  expect(version.factVersionIds.length).toBeGreaterThan(0)
  expect(version.body.modules?.every(module => module.factSourceIds.length > 0)).toBe(true)
  expect(service.approveContent(task.id, version.id).version.state).toBe('approved')
  return { service, product, task, version }
}

describe.sequential('PRD 17.2 - 10 个 P0 黄金 E2E 门禁', () => {
  it('正常详情页：已确认事实从 MerchantService 到 Review 再到 approved', () => {
    approvedDetail({ workspaceId: 'ws_golden_normal', title: '黄金通勤外套', price: 199 })
    observe('normal-detail')
  })

  it('无价格：不猜测价格且安全完成审核', () => {
    const { version } = approvedDetail({ workspaceId: 'ws_golden_no_price', title: '无价格商品' })
    expect(version.body.brief).not.toHaveProperty('priceExpression')
    expect(JSON.stringify(version.body)).not.toContain('¥')
    observe('no-price')
  })

  it('指定 SKU：只冻结被选 SKU', () => {
    const { task, version } = approvedDetail({
      workspaceId: 'ws_golden_sku', title: '指定 SKU 外套',
      skus: [{ id: 'sku-blue-m', name: '蓝色 M', price: 129, stock: 3 }, { id: 'sku-black-l', name: '黑色 L', price: 139, stock: 7 }],
      answers: { sku_id: 'sku-blue-m' },
    })
    expect(task.inputSnapshot).toMatchObject({ skuIds: ['sku-blue-m'], product: { price: 129, stock: 3, skuCount: 1 } })
    expect(version.versionVector?.skuIds).toEqual(['sku-blue-m'])
    observe('specified-sku')
  })

  it('多 SKU 同值：共享促销价可通过真实快照与审核', () => {
    const validTo = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const { task, version } = approvedDetail({
      workspaceId: 'ws_golden_same_price', title: '同价多 SKU 外套',
      skus: [{ id: 'sku-same-m', name: 'M', price: 159, stock: 4 }, { id: 'sku-same-l', name: 'L', price: 159, stock: 6 }],
      answers: { sku_id: 'sku-same-m', promotion_json: JSON.stringify([{ kind: 'activity', label: '同价活动', price_cny: 139, valid_to: validTo }]) },
      priceImpactConfirmed: true,
    })
    expect(task.inputSnapshot?.promotions).toEqual([expect.objectContaining({ label: '同价活动', priceCny: 139, skuIds: [] })])
    expect(version.body.brief?.priceExpression).toContain('139.00')
    observe('multi-sku-same-price')
  })

  it('多 SKU 冲突：不同价格的未分范围促销必须阻断', () => {
    const { service, product } = serviceAndProduct({
      workspaceId: 'ws_golden_price_conflict', title: '冲突价格外套',
      skus: [{ id: 'sku-conflict-m', name: 'M', price: 199, stock: 5 }, { id: 'sku-conflict-l', name: 'L', price: 219, stock: 5 }],
    })
    service.confirmProductFacts('ws_golden_price_conflict', product.id)
    const task = service.createTask({ workspaceId: 'ws_golden_price_conflict', productId: product.id, platform: 'taobao', requestText: '商品详情页' })
    const code = captureCode(() => service.answerTask('ws_golden_price_conflict', task.id, {
      sku_id: 'sku-conflict-m',
      promotion_json: JSON.stringify([{ kind: 'activity', label: '未分 SKU 活动', price_cny: 179, valid_to: new Date(Date.now() + 86_400_000).toISOString() }]),
    }))
    expect(task.state).toBe('draft')
    observe('multi-sku-price-conflict', [code])
  })

  it('过期活动价：输入边界立即阻断', () => {
    const { service, product } = serviceAndProduct({ workspaceId: 'ws_golden_expired_promo', title: '过期促销商品', price: 199 })
    service.confirmProductFacts('ws_golden_expired_promo', product.id)
    const task = service.createTask({ workspaceId: 'ws_golden_expired_promo', productId: product.id, platform: 'taobao', requestText: '商品详情页' })
    const code = captureCode(() => service.answerTask('ws_golden_expired_promo', task.id, {
      promotion_json: JSON.stringify([{ kind: 'activity', label: '已过期活动', price_cny: 99, valid_to: new Date(Date.now() - 86_400_000).toISOString() }]),
    }))
    expect(task.state).toBe('ready_for_direction')
    observe('expired-promotion', [code])
  })

  it('无授权图：方案确认时 fail-closed', () => {
    const { service, product } = serviceAndProduct({ workspaceId: 'ws_golden_unauthorized_image', title: '图片权益商品', price: 199 })
    service.confirmProductFacts('ws_golden_unauthorized_image', product.id)
    const asset = service.registerAsset({ workspaceId: 'ws_golden_unauthorized_image', name: 'rights-pending.png', mimeType: 'image/png', sizeBytes: 128, sha256: '7'.repeat(64), storageKey: 'quarantine/ws_golden_unauthorized_image/rights-pending.png' })
    const task = service.createTask({ workspaceId: 'ws_golden_unauthorized_image', productId: product.id, platform: 'taobao', requestText: '商品详情页' })
    service.answerTask('ws_golden_unauthorized_image', task.id, { asset_ids: [asset.id] })
    service.selectDirection(task.id, 'A')
    const code = captureCode(() => service.confirmProductionPlan('ws_golden_unauthorized_image', task.id, 'golden-gate'))
    expect(task.state).toBe('direction_selected')
    observe('unauthorized-image', [code])
  })

  it('无证明卖点：商品事实确认时 fail-closed', () => {
    const { service, product } = serviceAndProduct({
      workspaceId: 'ws_golden_unproven_claim', title: '待证明卖点商品', price: 199,
      sellingPoints: [{ id: 'sp-unproven', text: '防晒效果显著', proofStatus: 'pending', sourceIds: ['merchant-claim:pending'] }],
    })
    const code = captureCode(() => service.confirmProductFacts('ws_golden_unproven_claim', product.id))
    const task = service.createTask({ workspaceId: 'ws_golden_unproven_claim', productId: product.id, platform: 'taobao', requestText: '商品详情页' })
    expect(task.missingQuestions).toContainEqual(expect.objectContaining({ id: 'confirm_facts', kind: 'blocking' }))
    expect(task.state).toBe('draft')
    observe('unproven-selling-point', [code])
  })

  it('规则过期：生成前产生阻断问题', () => {
    const { service, product } = serviceAndProduct({ workspaceId: 'ws_golden_expired_rule', title: '规则过期商品', price: 199 })
    service.confirmProductFacts('ws_golden_expired_rule', product.id)
    const rule = service.publishRuleVersion({
      packId: 'golden-expired-rule', name: 'PRD 17.2 过期规则', version: 'golden-expired-rule-1.0.0', scope: 'global',
      effectiveTo: '2000-01-01T00:00:00.000Z', source: { kind: 'official', reference: 'fixture://prd-17.2/expired-rule', checkedAt: '1999-12-01T00:00:00.000Z' },
      checks: { forbiddenTerms: ['过期规则词'] }, actorId: 'golden-gate', reason: 'PRD 17.2 黄金门禁',
    })
    service.setRuleStatus({ packId: 'golden-expired-rule', version: rule.version, status: 'active', actorId: 'golden-gate', reason: '演练过期规则 fail-closed' })
    const task = service.createTask({ workspaceId: 'ws_golden_expired_rule', productId: product.id, platform: 'taobao', requestText: '商品详情页' })
    expect(task.missingQuestions).toContainEqual(expect.objectContaining({ id: 'rule_conflict', kind: 'blocking' }))
    expect(task.state).toBe('draft')
    observe('expired-rule', ['RULE_EXPIRED'])
  })

  it('修改与恢复：新建版本而不覆盖 approved 历史', () => {
    const { service, task, version: approved } = approvedDetail({ workspaceId: 'ws_golden_restore', title: '版本恢复商品', price: 299 })
    const approvedBody = structuredClone(approved.body)
    const modified = service.modifyContentVersion({ workspaceId: 'ws_golden_restore', sourceVersionId: approved.id, changes: { title: '运营修改版标题' }, reason: '黄金集修改演练' }).version
    const restored = service.restoreContentVersion('ws_golden_restore', approved.id).version

    expect(approved.state).toBe('approved')
    expect(approved.body).toEqual(approvedBody)
    expect(modified).toMatchObject({ parentId: approved.id, version: 2, state: 'review_required', body: { title: '运营修改版标题' } })
    expect(restored).toMatchObject({ parentId: approved.id, version: 3, state: 'review_required', body: approvedBody })
    expect(service.listContentVersions('ws_golden_restore', task.id).map(item => item.version)).toEqual([1, 2, 3])
    expect(service.reviewContent('ws_golden_restore', restored.id).filter(item => item.priority === 'P0')).toEqual([])
    expect(service.approveContent(task.id, restored.id).version.state).toBe('approved')
    observe('modify-and-restore')
  })

  afterAll(() => {
    expect(observations).toHaveLength(PRD_17_2_P0_GOLDEN_FIXTURES.length)
    expect(new Set(observations.map(item => item.id)).size).toBe(PRD_17_2_P0_GOLDEN_FIXTURES.length)
    const totals = observations.reduce((sum, item) => ({
      expectedP0: sum.expectedP0 + item.expectedP0,
      detectedP0: sum.detectedP0 + item.detectedP0,
      missedP0: sum.missedP0 + item.missedP0,
    }), { expectedP0: 0, detectedP0: 0, missedP0: 0 })
    expect(totals.detectedP0).toBe(totals.expectedP0)
    expect(totals.missedP0, `PRD 17.2 P0 漏检统计：${JSON.stringify(totals)}`).toBe(0)
  })
})
