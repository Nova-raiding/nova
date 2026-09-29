import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchManualPublishRecordPage, type ManualPublishRecord, type PublishJob } from './api'
import { ManualPublishRecordRow, PublishJobRecord } from './PublishHistoryPanel'

const envelope = (data: unknown) => new Response(JSON.stringify({
  request_id: 'manual-page-test', trace_id: 'manual-page-test', workspace_id: 'ws_demo',
  data, warnings: [], next_actions: [], error: null,
}), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('商家发布记录', () => {
  it('从服务端读取第 101 条之后的人工记录，保留分页总数和任务筛选', async () => {
    vi.stubGlobal('window', globalThis)
    const item = { id: 'manual-101', taskId: 'task-1', contentVersionId: 'content-1', platform: 'taobao', accountId: 'store-1', state: 'manual_publish_reported', recordedAt: '2026-09-29T00:00:00.000Z' }
    const fetcher = vi.fn().mockResolvedValue(envelope({ result: { items: [item], total: 101, limit: 20, offset: 100 } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchManualPublishRecordPage('/api', { limit: 20, offset: 100, taskId: 'task-1' })).resolves.toMatchObject({ items: [item], total: 101, offset: 100 })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      method: 'publish.manual.list', params: { limit: '20', offset: '100', task_id: 'task-1' },
    })
  })

  it('原样展示平台拒绝代码和字段，并指向原任务纠错', () => {
    const job = {
      id: 'job-1', workspaceId: 'ws_demo', taskId: 'task-1', contentVersionId: 'content-1',
      platform: 'taobao', accountId: 'store-1', idempotencyKey: 'key-1', state: 'rejected',
      confirmationHash: 'hash-1', remoteSnapshotHash: 'hash-2', createdAt: '2026-09-29T00:00:00.000Z',
      rejection: { rawCode: 'PLATFORM_422', message: '标题不合规', fields: [{ path: 'title', rawCode: 'TITLE_42', message: '含违禁词' }] },
    } satisfies PublishJob
    const html = renderToStaticMarkup(createElement(PublishJobRecord, { job, taskHref: '/merchant/tasks/task-1' }))
    expect(html).toContain('PLATFORM_422')
    expect(html).toContain('TITLE_42')
    expect(html).toContain('字段 title')
    expect(html).toContain('/merchant/tasks/task-1')
    expect(html).toContain('重新审核')
  })

  it('人工报告保持未验证边界，未知平台结果提示禁止重复提交', () => {
    const record = {
      id: 'manual-1', taskId: 'task-1', contentVersionId: 'content-1', platform: 'taobao',
      accountId: 'store-1', state: 'manual_publish_reported', recordedAt: '2026-09-29T00:00:00.000Z',
      platformContentId: 'remote-1', evidenceBoundary: 'manual_unverified',
    } satisfies ManualPublishRecord
    const manualHtml = renderToStaticMarkup(createElement(ManualPublishRecordRow, { record, taskHref: '/merchant/tasks/task-1' }))
    expect(manualHtml).toContain('未经平台接口验证')
    expect(manualHtml).toContain('不代表平台已发布')
    const unknown = {
      id: 'job-2', workspaceId: 'ws_demo', taskId: 'task-1', contentVersionId: 'content-1',
      platform: 'taobao', accountId: 'store-1', idempotencyKey: 'key-2', state: 'unknown',
      confirmationHash: 'hash-1', remoteSnapshotHash: 'hash-2', createdAt: '2026-09-29T00:00:00.000Z',
    } satisfies PublishJob
    expect(renderToStaticMarkup(createElement(PublishJobRecord, { job: unknown, taskHref: '/merchant/tasks/task-1' }))).toContain('不要重复提交')
  })
})
