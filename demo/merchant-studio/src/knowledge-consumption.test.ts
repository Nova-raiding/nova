import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

describe('merchant knowledge consumption contract', () => {
  it('shows the frozen workspace knowledge consumption state', () => {
    expect(app).toContain('data-testid="task-knowledge-consumption"')
    expect(app).toContain('已冻结')
    expect(app).toContain('生成内容后，这里会显示本次实际使用的 Ops 知识和规则版本。')
  })

  it('fails closed before generation while knowledge is not ready', () => {
    expect(app).toContain('taskContextBlocked')
    expect(app).toContain('taskStateBlocked')
    expect(app).toContain('服务端当前任务尚未返回规则版本；未展示任何演示规则。')
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
