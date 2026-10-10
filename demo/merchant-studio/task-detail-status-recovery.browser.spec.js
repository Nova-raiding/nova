import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_detail_status_fixture'
const jobId = 'job_task_detail_status_fixture'
const envelope = (data, error = null) => ({ request_id: 'task-detail-status-fixture', trace_id: 'task-detail-status-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const job = {
  job_id: jobId, revision: 4, state: 'succeeded', archive_state: 'archived', product_id: 'product_task_detail_status',
  task_id: 'task_task_detail_status', content_version_id: 'content_task_detail_status', image_mode: 'create',
  direction: '保留商品主体，清晰呈现款式', requested_count: 1, source_asset_ids: ['asset_task_detail_status'],
  source_product_version: 3, intent_hash: 'a'.repeat(64), execution_state: 'succeeded', provider_request_id: 'provider-fixture',
  execution_attempt: 1, reconciliation_required: false, error_code: null, error_message: null,
  updated_at: '2026-10-10T01:05:00.000Z', created_at: '2026-10-10T01:00:00.000Z',
  outputs: [{
    visual_ref: 'visual_task_detail_status', ordinal: 1, asset_id: 'asset_candidate_task_detail_status',
    archive_receipt_id: 'archive_task_detail_status', archive_receipt_digest: 'b'.repeat(64),
    storage_key: `clean/${workspaceId}/candidate.webp`, mime_type: 'image/webp', size_bytes: 1024,
    sha256: 'c'.repeat(64), created_at: '2026-10-10T01:04:00.000Z', review_status: 'passed',
    gate: { archive: 'archived', scan: 'clean', rights: 'approved', authenticity: 'verified', selectable: true, blockers: [] },
  }],
  images: ['data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="12" height="12"/%3E'],
  next_action: { type: 'select', label: '选择主图', allowed: true },
}

test('image task detail recovers from a failed status read using its explicit refresh action', async () => {
  test.setTimeout(120_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Task detail status fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const detailResponses = []
  const pageErrors = []
  let allowJobRead = false
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'task-detail-user', login: 'task-detail@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === `/v1/image-generation-jobs/${jobId}`) {
      if (!allowJobRead) {
        detailResponses.push('503')
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '任务状态读取暂时失败' })) })
      }
      detailResponses.push('200')
      data = job
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } }
          : method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 0 }
            : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] } : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    const deepLink = `${studioUrl}/merchant/tasks?image_job=${encodeURIComponent(jobId)}`
    await page.goto(deepLink, { waitUntil: 'domcontentloaded' })
    const error = page.locator('#image-job-read-error')
    await expect(error).toBeVisible()
    await expect(error).toContainText('任务状态读取失败')
    expect(detailResponses[0]).toBe('503')

    allowJobRead = true
    await page.getByRole('button', { name: '刷新任务状态' }).click()
    const panel = page.locator('.image-generation-job-panel')
    await expect(panel.getByText('生成完成，等待候选选择')).toBeVisible()
    await expect(page.getByRole('img', { name: /图片候选 1，可进入后续选择/u })).toBeVisible()
    await expect(error).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('image_job')).toBe(jobId)
    expect(detailResponses).toContain('200')
    expect(detailResponses.length).toBeGreaterThanOrEqual(2)
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
