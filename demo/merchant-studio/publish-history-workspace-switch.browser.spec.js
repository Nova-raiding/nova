import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceA = 'ws_publish_history_alpha'
const workspaceB = 'ws_publish_history_beta'
const envelope = (workspace, data) => ({ request_id: 'publish-history-workspace-fixture', trace_id: 'publish-history-workspace-fixture', workspace_id: workspace, data, warnings: [], next_actions: [], error: null })

test('publish history keeps B jobs after a late A history response', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Publish history workspace fixture did not bind an ephemeral TCP port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  const historyReads = []
  let delayAHistory = false
  let releaseAHistory
  const delayedAHistory = new Promise(resolve => { releaseAHistory = resolve })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== studioUrl) externalRequests.push(request.url())
  })

  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()

    const path = url.pathname.replace(/^\/api/u, '')
    const workspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 20, offset: 0 }
    if (path === '/v1/publish-jobs' && request.method() === 'GET') {
      historyReads.push({ workspace, offset: url.searchParams.get('offset') })
      if (workspace === workspaceA && delayAHistory) await delayedAHistory
      const suffix = workspace === workspaceB ? 'B' : 'A'
      data = { items: [{ id: `publish-${suffix}`, workspaceId: workspace, taskId: `task-${suffix}`, contentVersionId: `version-${suffix}`, platform: 'taobao', accountId: `store-${suffix}`, idempotencyKey: `key-${suffix}`, state: suffix === 'B' ? 'submitted' : 'queued', remoteState: suffix === 'B' ? 'submitted' : 'queued', confirmationHash: `confirm-${suffix}`, remoteSnapshotHash: `snapshot-${suffix}`, createdAt: suffix === 'B' ? '2026-10-11T08:00:00.000Z' : '2026-10-10T08:00:00.000Z' }], total: 1, limit: 20, offset: Number(url.searchParams.get('offset') ?? 0) }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspace, data)) })
  })

  try {
    await page.goto(`${studioUrl}/publish-history-workspace-switch-visual.html`, { waitUntil: 'domcontentloaded' })
    const panel = page.getByRole('region', { name: '发布记录' })
    await expect(panel).toContainText('等待运营处理 · 淘宝 · store-A')
    expect(historyReads[0]?.workspace).toBe(workspaceA)

    delayAHistory = true
    await panel.getByRole('button', { name: /刷新记录/u }).click()
    await expect.poll(() => historyReads.filter(read => read.workspace === workspaceA).length).toBeGreaterThan(1)
    await page.getByRole('button', { name: '切换到工作区 B' }).click()
    await expect(page.getByRole('status').filter({ hasText: `当前工作区：${workspaceB}` })).toBeVisible()
    await expect(panel).toContainText('已提交，待平台确认 · 淘宝 · store-B')
    await expect(panel).not.toContainText('store-A')

    releaseAHistory()
    await expect(panel).toContainText('已提交，待平台确认 · 淘宝 · store-B')
    await expect(panel).not.toContainText('store-A')
    expect(historyReads.some(read => read.workspace === workspaceA)).toBe(true)
    expect(historyReads.some(read => read.workspace === workspaceB)).toBe(true)
    expect(externalRequests).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    releaseAHistory?.()
    await context.close()
    await browser.close()
    await vite.close()
  }
})
