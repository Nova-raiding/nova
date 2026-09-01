import { describe, expect, it } from 'vitest'
import type { ContentModule, DetailPageEvidenceStatus } from '../../../packages/ai/src/generator.js'
import { orchestrateDetailPageModules } from './detail-page-orchestrator.js'

function module(
  key: string,
  input: {
    priority?: number
    optional?: boolean
    status?: DetailPageEvidenceStatus
    contentKind?: ContentModule['contentKind']
  } = {},
): ContentModule {
  const status = input.status ?? 'verified'
  return {
    key,
    title: key,
    purpose: `${key} task`,
    body: input.contentKind === 'pending' ? '[待确认] 尚未提供资料。' : `${key} body`,
    factSourceIds: ['fact:1'],
    ...(input.contentKind ? { contentKind: input.contentKind } : {}),
    decisionContract: {
      buyerQuestion: `${key}?`,
      pageTask: `${key} task`,
      claim: { text: `${key} claim`, factSourceIds: ['fact:1'], platforms: ['taobao'], limitations: [] },
      evidence: { type: 'parameter', sourceIds: status === 'verified' ? ['fact:1'] : [], status },
      visualContract: { requiredElements: [], protectedElements: [], prohibitedImplications: [], accessibilityText: key },
      priority: input.priority ?? 50,
      optional: input.optional ?? false,
    },
  }
}

describe('orchestrateDetailPageModules', () => {
  it('uses the eight-step rhythm only as the cookware default', () => {
    const modules = [
      module('summary', { priority: 1 }),
      module('usage_scenarios', { priority: 2 }),
      module('specifications', { priority: 3 }),
      module('compatibility', { priority: 4 }),
      module('experience', { priority: 5 }),
      module('solution', { priority: 6 }),
      module('details_craft', { priority: 7 }),
      module('hero', { priority: 8 }),
    ]

    const cookware = orchestrateDetailPageModules(modules, '厨房锅具')
    expect(cookware.rhythm).toBe('cookware_default_8_step')
    expect(cookware.modules.map(item => item.key)).toEqual([
      'hero', 'details_craft', 'solution', 'experience', 'compatibility', 'specifications', 'usage_scenarios', 'summary',
    ])

    const apparel = orchestrateDetailPageModules(modules, '服饰')
    expect(apparel.rhythm).toBe('dynamic_priority')
    expect(apparel.modules.map(item => item.key)).toEqual([
      'summary', 'usage_scenarios', 'specifications', 'compatibility', 'experience', 'solution', 'details_craft', 'hero',
    ])
  })

  it('keeps equal-priority modules in their original order', () => {
    const modules = [module('second'), module('first'), module('third')]
    expect(orchestrateDetailPageModules(modules, '数码').modules.map(item => item.key))
      .toEqual(['second', 'first', 'third'])
  })

  it('omits optional missing modules with an explicit non-success explanation', () => {
    const result = orchestrateDetailPageModules([
      module('hero', { priority: 1 }),
      module('evidence', { priority: 2, optional: true, status: 'missing' }),
    ], '服饰')

    expect(result.modules.map(item => item.key)).toEqual(['hero'])
    expect(result.omittedModules.map(item => item.key)).toEqual(['evidence'])
    expect(result.decisions.find(item => item.key === 'evidence')).toMatchObject({
      action: 'omit', readiness: 'blocked', evidenceStatus: 'missing',
    })
    expect(result.explanations.join('\n')).toContain('省略不代表证据已验证')
    expect(result.hasBlockingEvidence).toBe(true)
  })

  it('retains required missing evidence as blocked', () => {
    const result = orchestrateDetailPageModules([module('hero', { status: 'missing' })], '服饰')
    expect(result.modules.map(item => item.key)).toEqual(['hero'])
    expect(result.decisions[0]).toMatchObject({ action: 'retain', readiness: 'blocked', evidenceStatus: 'missing' })
  })

  it('can retain optional missing modules without presenting them as ready', () => {
    const result = orchestrateDetailPageModules(
      [module('evidence', { optional: true, status: 'missing' })],
      '服饰',
      {},
      { missingEvidencePolicy: 'retain_all' },
    )
    expect(result.omittedModules).toEqual([])
    expect(result.decisions[0]).toMatchObject({ action: 'retain', readiness: 'blocked', evidenceStatus: 'missing' })
  })

  it.each(['conflict', 'expired'] as const)('never hides %s evidence through the omission policy', status => {
    const result = orchestrateDetailPageModules([module('evidence', { optional: true, status })], '锅具')
    expect(result.modules.map(item => item.key)).toEqual(['evidence'])
    expect(result.omittedModules).toEqual([])
    expect(result.decisions[0]).toMatchObject({ action: 'retain', readiness: 'blocked', evidenceStatus: status })
  })

  it('does not let an external verified status bypass pending module evidence', () => {
    const result = orchestrateDetailPageModules(
      [module('materials', { optional: true, contentKind: 'pending', status: 'missing' })],
      'cookware',
      { materials: 'verified' },
    )
    expect(result.modules.map(item => item.key)).toEqual(['materials'])
    expect(result.decisions[0]).toMatchObject({ action: 'retain', readiness: 'blocked', evidenceStatus: 'pending' })
  })

  it('allows external evidence to strengthen missing evidence but never weaken a conflict', () => {
    const result = orchestrateDetailPageModules(
      [module('optional-proof', { optional: true, status: 'missing' }), module('conflicted', { status: 'conflict' })],
      '数码',
      { 'optional-proof': 'verified', conflicted: 'verified' },
    )
    expect(result.decisions.find(item => item.key === 'optional-proof')).toMatchObject({ readiness: 'ready', evidenceStatus: 'verified' })
    expect(result.decisions.find(item => item.key === 'conflicted')).toMatchObject({ readiness: 'blocked', evidenceStatus: 'conflict' })
  })
})
