import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceA = 'ws_image_job_alpha'
const workspaceB = 'ws_image_job_beta'
const envelope = (workspaceId, data) => ({ request_id: 'image-job-workspace-switch-fixture', trace_id: 'image-job-workspace-switch-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
const imageJob = (jobId, workspaceId) => ({
  job_id: jobId, revision: workspaceId === workspaceA ? 4 : 7,
  state: 'succeeded', archive_state: 'archived', product_id: `product-${workspaceId}`,
  task_id: `task-${workspaceId}`, content_version_id: `content-${workspaceId}`,
  image_mode: 'create', direction: '本地 fixture 任务', requested_count: 1,
  source_asset_ids: [], source_product_version: 1, intent_hash: 'd'.repeat(64),
  execution_state: 'succeeded', provider_request_id: `${workspaceId}-provider-marker`,
  execution_attempt: 1, reconciliation_required: false, error_code: null, error_message: null,
  updated_at: '2026-10-10T01:05:00.000Z', created_at: '2026-10-10T01:00:00.000Z',
  outputs: [], images: [], next_action: null,
})

test('image job detail ignores a late A read after switching workspace', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Image job workspace fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  const reads = []
  const pendingAReleases = []
  let holdA = true
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
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'image-job-reader', login: 'image-job@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const targetWorkspace = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${targetWorkspace}`, refresh_token: `refresh-${targetWorkspace}`, expires_in: 300, workspace_id: targetWorkspace }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/image-generation-jobs') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path.startsWith('/v1/image-generation-jobs/')) {
      const jobId = path.slice('/v1/image-generation-jobs/'.length)
      const owner = jobId === 'job-alpha-private' ? workspaceA : workspaceB
      reads.push({ jobId, workspace })
      if (owner === workspaceA && holdA) {
        await new Promise(resolve => pendingAReleases.push(resolve))
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceA, imageJob(jobId, workspaceA))) })
      }
      data = imageJob(jobId, owner)
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: { image_generation: false } } }
      else if (method === 'workspace.metrics') data = { result: { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} } }
      else data = { result: {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspace, data)) })
  })

  async function chooseWorkspace(label, workspaceId) {
    const selector = page.getByRole('combobox', { name: label, exact: true })
    await expect(selector).toBeVisible()
    const selectRoot = selector.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]')
    const selection = selector.locator('xpath=..')
    await selectRoot.locator('.ant-select-content').click({ force: true })
    await expect(selector).toHaveAttribute('aria-expanded', 'true')
    await page.getByText(`工作区 ID · ${workspaceId}`, { exact: true }).last().click()
    if (label === '选择当前商家工作区 ID') await expect(page.locator('.app-shell')).toBeVisible()
    else await expect(selection).toContainText(workspaceId)
  }
  async function openJob(jobId) {
    await page.evaluate(id => {
      window.history.pushState(null, '', `/merchant/tasks?image_job=${encodeURIComponent(id)}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, jobId)
  }

  try {
    await page.goto(`${studioUrl}/merchant/tasks`, { waitUntil: 'domcontentloaded' })
    await chooseWorkspace('选择当前商家工作区 ID', workspaceA)
    await openJob('job-alpha-private')
    await expect.poll(() => reads.filter(read => read.jobId === 'job-alpha-private' && read.workspace === workspaceA).length).toBe(1)

    await chooseWorkspace('按工作区 ID 切换当前商家工作区', workspaceB)
    await expect(page).toHaveURL(/\/merchant\/overview$/u)
    await openJob('job-beta-private')
    const evidence = page.locator('.image-generation-job-panel .image-job-evidence')
    await expect(evidence.getByText('ws_image_job_beta-provider-marker', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(evidence.getByText('ws_image_job_alpha-provider-marker', { exact: true })).toHaveCount(0)
    expect(reads.some(read => read.jobId === 'job-beta-private' && read.workspace === workspaceB)).toBe(true)

    holdA = false
    for (const release of pendingAReleases) release()
    await expect(evidence.getByText('ws_image_job_beta-provider-marker', { exact: true })).toBeVisible()
    await expect(evidence.getByText('ws_image_job_alpha-provider-marker', { exact: true })).toHaveCount(0)
    expect(pageErrors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    holdA = false
    for (const release of pendingAReleases) release()
    await context.close()
    await browser.close()
    await vite.close()
  }
})
