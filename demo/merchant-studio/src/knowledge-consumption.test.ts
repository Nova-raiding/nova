import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

describe('merchant knowledge consumption contract', () => {
  it('shows binding lifecycle states and routes unresolved knowledge to an action', () => {
    expect(app).toContain("approvalStatus: 'pending'")
    expect(app).toContain("rightsStatus: 'unknown'")
    expect(app).toContain("indexState: 'queued'")
    expect(app).toContain('data-testid="task-knowledge-binding"')
    expect(app).toContain('去知识库处理')
  })

  it('fails closed before generation while knowledge is not ready', () => {
    expect(app).toContain('知识绑定尚未 ready，不能生成')
    expect(app).toContain('!knowledgeSummary.ready')
    expect(app).toContain('未 ready 前不会调用生成接口')
    expect(app).toContain('Boolean(blockedBatchKnowledge)')
    expect(app).toContain('knowledgeSummaryForProduct(product.sourceAssetIds).ready')
  })

  it('shows the frozen Ops knowledge returned by the generated content version', () => {
    expect(api).toContain('knowledgeContext?:')
    expect(api).toContain('confirmedLearningSuggestions')
    expect(app).toContain('data-testid="task-knowledge-consumption"')
    expect(app).toContain('已用于本次生成')
    expect(app).toContain('本次实际使用的 Ops 知识和规则版本')
    expect(app).toContain('未将演示数据冒充为消费记录')
  })

  it('labels the brief without implying that a video has already been rendered', () => {
    expect(app).toContain('创意 Brief（脚本/分镜或静态素材）')
    expect(app).not.toContain('视频已生成')
  })
})
