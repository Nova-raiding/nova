import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

describe('task queue search wiring', () => {
  it('submits a scoped task query, resets pagination, and sends it to the paged API', () => {
    expect(app).toContain('role="search"\n          aria-label="搜索任务队列"')
    expect(app).toContain('setTaskSearchQuery(taskSearchDraft.trim())')
    expect(app).toContain('搜索任务 ID、商品名称或店铺名称')
    expect(app).toContain('输入任务 ID、商品名称或店铺名称')
    expect(app).toContain('setTaskPage(0)')
    expect(app).toContain('...(taskSearchQuery ? { query: taskSearchQuery } : {})')
    expect(app).toContain('taskSearchQuery])')
    expect(api).toContain('if (filters.query) params.set(\'query\', filters.query)')
  })

  it('shows an explicit no-match state with a way to clear the filter', () => {
    expect(app).toContain("taskSearchQuery ? '没有匹配的营销任务' : '暂无营销任务'")
    expect(app).toContain('清除搜索查看全部任务。')
  })
})
