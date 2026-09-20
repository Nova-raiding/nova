import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectPublishJobRows } from './App'
import type { PublishJob } from './api'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

const job = (overrides: Partial<PublishJob>): PublishJob => ({
  id: 'publish-job-raw-id',
  workspaceId: 'ws_demo',
  taskId: 'task-1',
  contentVersionId: 'version-1',
  platform: 'taobao',
  idempotencyKey: 'merchant-studio-publish-v1:task-1',
  state: 'submitted',
  confirmationHash: 'confirmation-hash',
  remoteSnapshotHash: 'remote-snapshot-hash',
  createdAt: '2026-09-20T02:00:00.000Z',
  ...overrides,
})

describe('publish center keeps the platform rejection evidence', () => {
  // Regression: the list projection rewrote `rejection.rawCode` with the literal
  // string '平台拒绝' and dropped every field code, so the merchant-facing card
  // 「平台拒绝码：…」 showed the same fixed label for every rejection and the
  // UI's own '平台未返回代码' branch could never be reached. The PRD requires the
  // receipt to keep the original error code, field paths and actionable message.
  it('renders the code the platform actually returned', () => {
    const [row] = projectPublishJobRows([
      job({
        state: 'rejected',
        rejection: {
          rawCode: 'TOP-27',
          message: '标题过长',
          fields: [{ path: 'title', rawCode: 'TITLE-LONG', message: '缩短标题' }],
        },
      }),
    ])
    expect(row?.rejection).toEqual({
      rawCode: 'TOP-27',
      message: '标题过长',
      fields: [{ path: 'title', rawCode: 'TITLE-LONG', message: '缩短标题' }],
    })
    // The fabricated constant must not come back.
    expect(app).not.toContain("rawCode: '平台拒绝'")
    expect(app).toContain('平台拒绝码：{job.rejection?.rawCode')
  })

  it('keeps a rejection without a message and without field codes renderable', () => {
    const [row] = projectPublishJobRows([
      job({ state: 'rejected', rejection: { rawCode: 'TOP-1', fields: [{ path: 'price', message: '价格异常' }] } }),
    ])
    expect(row?.rejection).toEqual({ rawCode: 'TOP-1', fields: [{ path: 'price', message: '价格异常' }] })
  })

  it('keeps the existing ordering, positional label and remote-state redaction', () => {
    const rows = projectPublishJobRows([
      job({ id: 'new', createdAt: '2026-09-20T03:00:00.000Z' }),
      job({ id: 'old', createdAt: '2026-09-20T01:00:00.000Z', state: 'rejected', rejection: { rawCode: 'TOP-2', fields: [] } }),
      job({ id: 'middle', createdAt: '2026-09-20T02:00:00.000Z', remoteState: 'WAIT_SELLER_SEND_GOODS' }),
    ])
    expect(rows.map((row) => row.id)).toEqual(['发布请求 1', '发布请求 2', '发布请求 3'])
    expect(rows[0]?.state).toBe('rejected')
    expect(rows[1]?.createdAt).toBe('2026-09-20T03:00:00.000Z')
    expect(rows.every((row) => row.remoteState === undefined)).toBe(true)
    expect(rows.every((row) => row.rejection === undefined || row.rejection.rawCode.length > 0)).toBe(true)
    // The projection must not mutate the server payload it was handed.
    expect(new Set(rows.map((row) => row.taskId))).toEqual(new Set(['task-1']))
  })
})
