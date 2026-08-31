import { bench, describe } from 'vitest'
import { budgetContentGenerationInput, estimateContentGenerationRequestTokens } from './generator.js'

const input = budgetContentGenerationInput({
  platform: 'taobao',
  directionId: 'A',
  product: { title: '轻云防晒外套', category: '女装', stock: 1286, skuCount: 8, attributes: { material: '锦纶', season: '春夏' } },
  knowledgeContext: {
    rules: Array.from({ length: 8 }, (_, index) => ({ id: `rule-${index}`, content: '标题必须基于已确认商品事实，不得使用绝对化表达。'.repeat(8), version: '1', sourceReference: 'official' })),
    assets: Array.from({ length: 8 }, (_, index) => ({ id: `asset-${index}`, kind: 'brand' as const, name: '品牌资料', content: '品牌资料内容'.repeat(80), revision: 1, confirmed: false as const })),
    confirmedLearningSuggestions: Array.from({ length: 8 }, (_, index) => ({ id: `learning-${index}`, summary: '建议突出已确认卖点', proposedRule: { content: '只使用已确认事实', scope: 'global', version: '1' } })),
  },
}, 3_900)

describe('content generation context benchmark', () => {
  bench('estimates initial request', () => {
    estimateContentGenerationRequestTokens(input)
  })
  bench('estimates repair request from the bounded prompt', () => {
    estimateContentGenerationRequestTokens(input, ['只修复结构和缺失字段'])
  })
})
