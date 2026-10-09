import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { PublishJob } from './api'
import { PublishJobRecord } from './PublishHistoryPanel'

it('keeps an unknown local job with a published remote observation visibly unresolved', () => {
  const job = {
    id: 'job-unknown-published', workspaceId: 'ws_demo', taskId: 'task-1', contentVersionId: 'content-1',
    platform: 'taobao', accountId: 'store-1', idempotencyKey: 'key-1', state: 'unknown', remoteState: 'published',
    createdAt: '2026-10-09T00:00:00.000Z',
  } satisfies PublishJob
  const html = renderToStaticMarkup(createElement(PublishJobRecord, { job, taskHref: '/merchant/tasks/task-1' }))
  expect(html).toContain('平台回执显示已发布 · 任务对账未结案')
  expect(html).toContain('任务对账尚未结案')
  expect(html).toContain('当前不要重复提交')
})
