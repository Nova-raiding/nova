import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { PublishJob } from './api'
import { PublishJobRecord } from './PublishHistoryPanel'

it('平台已发布但本地仍在对账时明确显示未结案并禁止重复提交', () => {
  const job = {
    id: 'job-drift', workspaceId: 'ws_demo', taskId: 'task-drift', contentVersionId: 'content-1',
    platform: 'taobao', accountId: 'store-1', idempotencyKey: 'key-drift', state: 'reconciling',
    remoteState: 'published', confirmationHash: 'hash-1', remoteSnapshotHash: 'hash-2',
    createdAt: '2026-09-29T00:00:00.000Z',
  } satisfies PublishJob
  const html = renderToStaticMarkup(createElement(PublishJobRecord, { job, taskHref: '/merchant/tasks/task-drift' }))
  expect(html).toContain('平台回执显示已发布 · 任务对账未结案')
  expect(html).toContain('任务对账尚未结案')
  expect(html).toContain('当前不要重复提交')
})
