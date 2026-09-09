import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

describe('merchant customer-support entry', () => {
  it('uses the current task association before asking for a ticket UUID', () => {
    expect(app).toContain('查看当前任务关联工单')
    expect(app).toContain('relatedTaskId={taskContext?.task.id}')
    expect(app).toContain('可选：已有工单才填写 UUID')
  })

  it('keeps association filters and customer-safe response shape in the API client', () => {
    expect(api).toContain('related_task_id')
    expect(api).toContain('related_order_id')
    expect(api).toContain('tickets?:')
  })
})
