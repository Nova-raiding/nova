import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchManualPublishRecordPage, type ManualPublishRecord, type PublishJob } from './api'
import { describePublishHistoryReadError, ManualPublishRecordRow, PublishJobRecord } from './PublishHistoryPanel'

const envelope = (data: unknown) => new Response(JSON.stringify({
  request_id: 'manual-page-test', trace_id: 'manual-page-test', workspace_id: 'ws_demo',
  data, warnings: [], next_actions: [], error: null,
}), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('商家发布记录', () => {
  it('发布记录读取错误只给出读取恢复指引，不误报写入结果或模型故障', () => {
    const error = Object.assign(new Error('service unavailable'), { code: 'PUBLISH_READ_UNAVAILABLE', status: 503 })
    const message = describePublishHistoryReadError(error)
    expect(message).toBe('发布记录暂时无法读取，请检查 API 连接后重试。')
    expect(message).not.toContain('操作未确认')
    expect(message).not.toContain('模型中转')
    expect(message).not.toContain('插件连接')
  })

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
    expect(html).toContain('标题（原始字段 title）')
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

  it('准备与确认状态为中文，非法时间显示中文兜底', () => {
    const base = {
      id: 'job-3', workspaceId: 'ws_demo', taskId: 'task-3', contentVersionId: 'content-3',
      platform: 'taobao', accountId: 'store-1', idempotencyKey: 'key-3',
      confirmationHash: 'hash-1', remoteSnapshotHash: 'hash-2', createdAt: 'invalid-date',
    } satisfies Omit<PublishJob, 'state'>
    const prepared = renderToStaticMarkup(createElement(PublishJobRecord, { job: { ...base, state: 'prepared' }, taskHref: '/merchant/tasks/task-3' }))
    const confirmed = renderToStaticMarkup(createElement(PublishJobRecord, { job: { ...base, state: 'confirmed' }, taskHref: '/merchant/tasks/task-3' }))
    expect(prepared).toContain('发布预览已准备')
    expect(confirmed).toContain('发布确认已记录，待入队')
    expect(prepared).toContain('时间待核对')
    expect(prepared).not.toContain('Invalid Date')
  })

  it('任务队列深链能突出显示刚创建的发布任务 ID', () => {
    const job = {
      id: 'job-focus-42', workspaceId: 'ws_demo', taskId: 'task-42', contentVersionId: 'content-42',
      platform: 'taobao', accountId: 'store-42', idempotencyKey: 'key-focus-42', state: 'queued',
      confirmationHash: 'hash-1', remoteSnapshotHash: 'hash-2', createdAt: '2026-10-09T00:00:00.000Z',
    } satisfies PublishJob
    const html = renderToStaticMarkup(createElement(PublishJobRecord, { job, taskHref: '/merchant/tasks/task-42', focusJobId: job.id }))
    expect(html).toContain('id="publish-job-job-focus-42"')
    expect(html).toContain('publish-job-focused')
    expect(html).toContain('刚创建的发布任务：job-focus-42')
    expect(html).toContain('aria-current="true"')
  })
})
