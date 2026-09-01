import { describe, expect, it } from 'vitest'
import {
  createContentVersion,
  type ContentModule,
} from '../packages/domain/src/index.js'

type DecisionContract = NonNullable<ContentModule['decisionContract']>
type DecisionIssue =
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_CONFLICT'
  | 'EVIDENCE_EXPIRED'
  | 'SKU_SCOPE_MISMATCH'
  | 'PLATFORM_SCOPE_MISMATCH'

type DecisionScope = {
  skuIds: readonly string[]
  platform: string
  now: string
}

const POT_DETAIL_RHYTHM = [
  { key: 'hero', title: '购买理由', buyerQuestion: '为什么值得继续看？', pageTask: '建立一个主购买理由' },
  { key: 'material', title: '材料安全', buyerQuestion: '材料是否让我安心？', pageTask: '用可核验材料证据建立安全感' },
  { key: 'result', title: '功能结果', buyerQuestion: '少油不粘能否产生真实结果？', pageTask: '用烹饪结果证明功能宣称' },
  { key: 'experience', title: '使用体验', buyerQuestion: '拿在手里是否轻巧顺手？', pageTask: '把重量和手柄参数翻译成手感' },
  { key: 'compatibility', title: '炉具适配', buyerQuestion: '我家的炉具能不能用？', pageTask: '降低炉具适配确认成本' },
  { key: 'specification', title: '规格选择', buyerQuestion: '我应该选择哪个尺寸？', pageTask: '把尺寸映射到人数和使用场景' },
  { key: 'scene', title: '使用场景', buyerQuestion: '买回家以后会不会经常用？', pageTask: '扩展真实烹饪用途想象' },
  { key: 'summary', title: '信任收束', buyerQuestion: '关键信息是否足够让我确认？', pageTask: '收束已证明的卖点、规格和适配信息' },
] as const

const runtime = () => {
  let sequence = 0
  return {
    now: () => '2026-09-01T08:00:00.000Z',
    nextId: (prefix: string) => `${prefix}_mock_${++sequence}`,
  }
}

function contractFor(
  segment: (typeof POT_DETAIL_RHYTHM)[number],
  overrides: {
    evidenceStatus?: DecisionContract['evidence']['status']
    skuIds?: string[]
    platforms?: string[]
    validUntil?: string
  } = {},
): DecisionContract {
  const sourceId = `mock://pot-detail/${segment.key}`
  const evidenceStatus = overrides.evidenceStatus ?? 'verified'
  return {
    buyerQuestion: segment.buyerQuestion,
    pageTask: segment.pageTask,
    claim: {
      text: `${segment.title}的 mock 宣称`,
      factSourceIds: [sourceId],
      skuIds: overrides.skuIds ?? ['pot-30cm'],
      platforms: overrides.platforms ?? ['taobao'],
      ...(overrides.validUntil ? { validUntil: overrides.validUntil } : {}),
      limitations: ['仅用于契约测试，不代表真实商品事实或生产发布结果'],
    },
    evidence: {
      type: segment.key === 'material' ? 'test_report' : segment.key === 'result' ? 'usage_result' : 'parameter',
      sourceIds: evidenceStatus === 'missing' ? [] : [sourceId],
      status: evidenceStatus,
    },
    visualContract: {
      requiredElements: [segment.title, '对应事实证据'],
      protectedElements: ['商品结构', '品牌标识'],
      prohibitedImplications: ['不得把 mock 证据表述为真实检测或生产成功'],
      accessibilityText: `${segment.title}：${segment.pageTask}`,
    },
    priority: POT_DETAIL_RHYTHM.findIndex(item => item.key === segment.key) + 1,
    optional: false,
  }
}

function mockDetailModules(overrides: Partial<Record<(typeof POT_DETAIL_RHYTHM)[number]['key'], Parameters<typeof contractFor>[1]>> = {}) {
  const modules: ContentModule[] = POT_DETAIL_RHYTHM.map(segment => {
    const decisionContract = contractFor(segment, overrides[segment.key])
    return {
      key: segment.key,
      title: segment.title,
      purpose: segment.pageTask,
      body: decisionContract.claim.text,
      factSourceIds: decisionContract.claim.factSourceIds,
      contentKind: decisionContract.evidence.status === 'verified' ? 'fact' : 'pending',
      referencedSkuIds: decisionContract.claim.skuIds,
      decisionContract,
    }
  })
  return createContentVersion({
    taskId: 'task_pot_detail_mock',
    body: { title: '锅具详情页 mock', detail: '仅用于决策契约黄金测试', sellingPoints: [], modules },
    createdBy: 'mock-golden-test',
    reason: 'exercise detail-page decision contract without production claims',
  }, runtime()).body.modules ?? []
}

function evaluateDecision(contract: DecisionContract, scope: DecisionScope) {
  const issues: DecisionIssue[] = []
  if (contract.evidence.status === 'missing') issues.push('EVIDENCE_MISSING')
  if (contract.evidence.status === 'conflict') issues.push('EVIDENCE_CONFLICT')
  if (contract.evidence.status === 'expired' || (contract.claim.validUntil && contract.claim.validUntil <= scope.now)) issues.push('EVIDENCE_EXPIRED')
  if (contract.claim.skuIds?.some(skuId => !scope.skuIds.includes(skuId))) issues.push('SKU_SCOPE_MISMATCH')
  if (!contract.claim.platforms.includes(scope.platform)) issues.push('PLATFORM_SCOPE_MISMATCH')
  return { verdict: issues.length === 0 ? 'verified' as const : 'blocked' as const, issues }
}

const scope: DecisionScope = {
  skuIds: ['pot-30cm'],
  platform: 'taobao',
  now: '2026-09-01T08:00:00.000Z',
}

function moduleContract(modules: readonly ContentModule[], key: (typeof POT_DETAIL_RHYTHM)[number]['key']) {
  const contract = modules.find(module => module.key === key)?.decisionContract
  if (!contract) throw new Error(`缺少 ${key} mock 决策契约`)
  return contract
}

describe('锅具详情页决策契约 mock 黄金测试', () => {
  it('按八段默认节奏保留单一买家问题、页面任务和可访问文本', () => {
    const modules = mockDetailModules()

    expect(modules.map(module => module.key)).toEqual(POT_DETAIL_RHYTHM.map(segment => segment.key))
    expect(modules.map(module => module.decisionContract?.priority)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(modules.every(module => Boolean(module.decisionContract?.buyerQuestion))).toBe(true)
    expect(modules.every(module => Boolean(module.decisionContract?.pageTask))).toBe(true)
    expect(modules.every(module => Boolean(module.decisionContract?.visualContract.accessibilityText))).toBe(true)
  })

  it('verified：八段仅通过 mock 决策资格，不声称生产发布成功', () => {
    const modules = mockDetailModules()
    const results = modules.map(module => evaluateDecision(module.decisionContract!, scope))

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ verdict: 'verified', issues: [] })))
    expect(JSON.stringify(modules)).not.toContain('published')
    expect(JSON.stringify(modules)).toContain('不代表真实商品事实或生产发布结果')
  })

  it.each([
    { name: 'missing', key: 'material' as const, overrides: { evidenceStatus: 'missing' as const }, issue: 'EVIDENCE_MISSING' as const },
    { name: 'conflict', key: 'result' as const, overrides: { evidenceStatus: 'conflict' as const }, issue: 'EVIDENCE_CONFLICT' as const },
    { name: 'expired', key: 'experience' as const, overrides: { evidenceStatus: 'expired' as const, validUntil: '2026-08-31T23:59:59.000Z' }, issue: 'EVIDENCE_EXPIRED' as const },
    { name: 'SKU 错配', key: 'specification' as const, overrides: { skuIds: ['pot-32cm'] }, issue: 'SKU_SCOPE_MISMATCH' as const },
    { name: '平台错配', key: 'compatibility' as const, overrides: { platforms: ['jd'] }, issue: 'PLATFORM_SCOPE_MISMATCH' as const },
  ])('$name：对应页面必须 fail-closed', ({ key, overrides, issue }) => {
    const modules = mockDetailModules({ [key]: overrides })

    expect(evaluateDecision(moduleContract(modules, key), scope)).toEqual({ verdict: 'blocked', issues: [issue] })
  })

  it('即使状态标为 verified，过期时间仍独立阻断', () => {
    const modules = mockDetailModules({
      material: { evidenceStatus: 'verified', validUntil: '2026-08-31T23:59:59.000Z' },
    })

    expect(evaluateDecision(moduleContract(modules, 'material'), scope)).toEqual({ verdict: 'blocked', issues: ['EVIDENCE_EXPIRED'] })
  })
})
