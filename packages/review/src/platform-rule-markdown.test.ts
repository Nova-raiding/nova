import { describe, expect, it } from 'vitest'
import { parsePlatformRuleMarkdown } from './platform-rule-markdown.js'

describe('parsePlatformRuleMarkdown', () => {
  it('splits reviewed PDD cards into inactive-by-default platform drafts', () => {
    const rules = parsePlatformRuleMarkdown(`# Store Nova｜拼多多平台规则知识库 v0.1\n\n## PDD-GEN-001｜商品描述\n- 平台：拼多多；地区：中国大陆\n- 官方依据：[官方规则](https://example.test/rule)，版本生效 2026-04-10\n\n## PDD-IMG-001｜主图\n- 平台：拼多多；地区：中国大陆\n- 官方依据：[官方规则](https://example.test/image)，版本生效 2026-04-10`, '2026-09-18T00:00:00.000Z')
    expect(rules).toHaveLength(2)
    expect(rules[0]).toMatchObject({ packId: 'pinduoduo-manual-pdd-gen-001', platform: 'pinduoduo', scope: 'platform', status: 'draft', sourceKind: 'official', version: '0.1', sourceCheckedAt: '2026-09-18T00:00:00.000Z' })
    expect(rules[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u)
    expect(rules[1]?.content).toContain('PDD-IMG-001')
  })

  it('rejects a card without official evidence', () => {
    expect(() => parsePlatformRuleMarkdown('## PDD-GEN-001｜缺来源\n- 平台：拼多多')).toThrow('缺少官方依据')
  })
})
