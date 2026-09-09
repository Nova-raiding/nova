import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

describe('merchant knowledge consumption contract', () => {
  it('shows the frozen Ops knowledge returned by the generated content version', () => {
    expect(api).toContain('knowledgeContext?:')
    expect(api).toContain('confirmedLearningSuggestions')
    expect(app).toContain('data-testid="task-knowledge-consumption"')
    expect(app).toContain('已用于本次生成')
    expect(app).toContain('本次实际使用的 Ops 知识和规则版本')
    expect(app).toContain('未将演示数据冒充为消费记录')
  })
})
