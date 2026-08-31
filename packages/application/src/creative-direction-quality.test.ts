import { describe, expect, it } from 'vitest'
import {
  assertCreativeDirectionsClearlyDifferent,
  CreativeDirectionQualityError,
  evaluateCreativeDirectionQuality,
  type CreativeDirectionQualityCandidate,
} from './creative-direction-quality.js'

const direction = (input: Partial<CreativeDirectionQualityCandidate> & Pick<CreativeDirectionQualityCandidate, 'id'>): CreativeDirectionQualityCandidate => ({
  id: input.id,
  name: input.name ?? `方向 ${input.id}`,
  coreIdea: input.coreIdea ?? '真实场景解决通勤需求',
  structure: input.structure ?? '场景开篇→使用收益→行动号召',
  visualDirection: input.visualDirection ?? '暖色自然光与通勤环境',
  copyDirection: input.copyDirection ?? '具体可信的使用收益表达',
  sellingPoints: input.sellingPoints ?? ['轻便', '通勤'],
  fitReason: input.fitReason ?? '适合关注日常使用体验的人群',
  risk: input.risk ?? '不得扩写未经确认的使用功效',
})

describe('creative direction local quality gate', () => {
  it('accepts three directions with different narrative, structure and visual strategy', () => {
    const report = evaluateCreativeDirectionQuality([
      direction({ id: 'A' }),
      direction({ id: 'B', coreIdea: '用材质和工艺证据建立商品可信度', structure: '材质特写→工艺参数→SKU 对照', visualDirection: '中性微距摄影与纹理细节', copyDirection: '参数化短句，证据优先', sellingPoints: ['面料参数', '做工细节'], fitReason: '适合理性比较规格的用户', risk: '材质参数必须绑定事实来源' }),
      direction({ id: 'C', coreIdea: '移动端首屏快速传递促销行动', structure: '一句主张→价格信息→售后与 CTA', visualDirection: '高留白卡片和强层级排版', copyDirection: '短促易扫读并遵守平台字数', sellingPoints: ['核心利益点', '售后保障'], fitReason: '适合快速浏览和转化任务', risk: '无有效活动快照时不得展示价格' }),
    ])

    expect(report.passed).toBe(true)
    expect(report.pairScores).toHaveLength(3)
    expect(report.pairScores.every(pair => pair.differentDimensions.length >= report.thresholds.minDifferentDimensions)).toBe(true)
    expect(assertCreativeDirectionsClearlyDifferent([
      direction({ id: 'A' }),
      direction({ id: 'B', coreIdea: '材质细节证明', structure: '工艺→参数→规格', visualDirection: '中性微距', copyDirection: '证据短句', sellingPoints: ['材质'], fitReason: '规格比较', risk: '参数须有来源' }),
      direction({ id: 'C', coreIdea: '售后服务说明', structure: '服务承诺→流程→CTA', visualDirection: '图标信息图', copyDirection: '步骤说明', sellingPoints: ['售后'], fitReason: '降低决策顾虑', risk: '不得虚构服务' }),
    ]).passed).toBe(true)
  })

  it('rejects Chinese synonym rewrites after canonical normalization', () => {
    const report = evaluateCreativeDirectionQuality([
      direction({ id: 'A', coreIdea: '极简质感，突出核心卖点', structure: '核心卖点→商品证明→CTA', visualDirection: '极简高端感', copyDirection: '简洁并强调主要利益点', sellingPoints: ['核心卖点'], fitReason: '适合高端用户', risk: '避免绝对化' }),
      direction({ id: 'B', coreIdea: '简约高级感，强调主要利益点', structure: '主要利益点→商品证明→CTA', visualDirection: '简约品质感', copyDirection: '极简并突出核心利益点', sellingPoints: ['主要卖点'], fitReason: '适合高端用户', risk: '避免绝对化' }),
      direction({ id: 'C', coreIdea: '材质细节与参数证明', structure: '细节→参数→SKU', visualDirection: '微距中性光', copyDirection: '事实型参数短句', sellingPoints: ['材质', '工艺'], fitReason: '适合理性比较', risk: '参数必须有来源' }),
    ])

    expect(report.passed).toBe(false)
    const pair = report.pairScores.find(item => item.directionIds.join('/') === 'A/B')!
    expect(pair.passed).toBe(false)
    expect(pair.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(['TOKEN_SIMILARITY_TOO_HIGH', 'OVERALL_SIMILARITY_TOO_HIGH', 'INSUFFICIENT_FIELD_DIFFERENCE']))
    expect(pair.dimensionSimilarities.coreIdea).toBe(1)
  })

  it('handles short bilingual text and configurable synonyms deterministically', () => {
    const report = evaluateCreativeDirectionQuality([
      direction({ id: 'A', coreIdea: 'Fast', structure: 'A-B', visualDirection: 'Red', copyDirection: 'Bold', sellingPoints: ['Light'], fitReason: 'Gen Z', risk: 'No claims' }),
      direction({ id: 'B', coreIdea: 'Quick', structure: 'A B', visualDirection: 'red', copyDirection: 'bold', sellingPoints: ['light'], fitReason: 'gen-z', risk: 'no claims' }),
      direction({ id: 'C', coreIdea: '慢工艺', structure: '细节 参数', visualDirection: '蓝色微距', copyDirection: '证据', sellingPoints: ['耐用'], fitReason: '专业用户', risk: '参数待确认' }),
    ], { synonyms: { speed: ['fast', 'quick'] } })

    const pair = report.pairScores[0]!
    expect(pair.passed).toBe(false)
    expect(pair.dimensionSimilarities.coreIdea).toBe(1)
    expect(pair.tokenSimilarity).toBeGreaterThanOrEqual(report.thresholds.maxTokenSimilarity)
  })

  it('returns explainable scores and throws a structured rejection error', () => {
    const duplicate = direction({ id: 'A' })
    const candidates = [duplicate, { ...duplicate, id: 'B', name: '换个名字' }, direction({ id: 'C', coreIdea: '材质证明', structure: '细节→参数', visualDirection: '微距', copyDirection: '参数', sellingPoints: ['工艺'], fitReason: '规格比较', risk: '须有来源' })]

    try {
      assertCreativeDirectionsClearlyDifferent(candidates)
      throw new Error('expected quality rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(CreativeDirectionQualityError)
      const qualityError = error as CreativeDirectionQualityError
      expect(qualityError.code).toBe('CREATIVE_DIRECTIONS_NOT_DISTINCT')
      expect(qualityError.report.passed).toBe(false)
      expect(qualityError.report.thresholds).toMatchObject({ maxTokenSimilarity: 0.78, maxOverallSimilarity: 0.72, maxSimilarDimensionScore: 0.5, minDifferentDimensions: 3 })
      expect(qualityError.report.pairScores[0]).toMatchObject({ directionIds: ['A', 'B'], tokenSimilarity: 1, overallSimilarity: 1, diversityScore: 0, passed: false })
      expect(qualityError.report.pairScores[0]?.reasons.every(reason => typeof reason.message === 'string' && typeof reason.actual === 'number' && typeof reason.threshold === 'number')).toBe(true)
    }
  })

  it('fails closed for malformed sets and invalid thresholds', () => {
    const report = evaluateCreativeDirectionQuality([direction({ id: 'A', risk: '' }), direction({ id: 'A' })])
    expect(report.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(['DIRECTION_COUNT_INVALID', 'DIRECTION_ID_DUPLICATE', 'DIRECTION_CONTENT_INSUFFICIENT']))
    expect(() => evaluateCreativeDirectionQuality([direction({ id: 'A' }), direction({ id: 'B' }), direction({ id: 'C' })], { thresholds: { minDifferentDimensions: 8 } })).toThrow('CREATIVE_DIRECTION_QUALITY_THRESHOLD_INVALID:minDifferentDimensions')
  })
})
