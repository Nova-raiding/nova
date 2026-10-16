import { createHash } from 'node:crypto'
import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_version_return_fixture'
const taskId = 'task_version_return_fixture'
const currentId = 'content_version_current_return_fixture'
const oldId = 'content_version_old_return_fixture'
const envelope = (data, error = null) => ({ request_id: 'task-version-return-fixture', trace_id: 'task-version-return-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const versions = [
  { id: currentId, taskId, version: 2, body: { title: '当前内容版本标题', detail: '当前版本详情', sellingPoints: ['当前卖点'] }, factVersionIds: ['fact-current'], ruleVersionIds: ['rule-current'], state: 'review_required', revision: 2 },
  { id: oldId, taskId, version: 1, body: { title: '历史内容版本标题', detail: '历史版本详情', sellingPoints: ['历史卖点'] }, factVersionIds: ['fact-old'], ruleVersionIds: ['rule-old'], knowledgeContext: { rules: [], assets: [], confirmedLearningSuggestions: [] }, state: 'superseded', revision: 1 },
]

for (const scenario of ['late-approve-version', 'late-approve-task', 'late-export-version', 'late-export-task', 'late-export-current']) {
test(`content version display preserves ${scenario} evidence and current-version identity`, async () => {
  const exporting = scenario.includes('export')
  const switchTask = scenario.endsWith('task')
  const switchVersion = scenario.endsWith('version')
  let releaseReply
  const heldReply = new Promise(resolve => { releaseReply = resolve })
  let requestHeld = false
  let replyFinished = false
  let versionReadMode = scenario
  let reviewUnavailable = ['review-failed', 'review-recovery'].includes(scenario)
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Task version history return fixture did not bind an ephemeral TCP port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const writeAttempts = []
  const approvalWrites = []
  const reviewReads = []
  const requests = []
  const browserErrors = []
  await page.addInitScript(() => { window.fixtureDownloads = []; HTMLAnchorElement.prototype.click = function () { window.fixtureDownloads.push(this.download) } })
  page.on('pageerror', error => browserErrors.push(error.message))
  const readOnlyMcpMethods = new Set(['billing.transactions', 'canonical.product.consistency', 'commercial.catalog.get', 'commercial.subscription.get', 'creative-points.balance.get', 'creative-points.statement.list', 'platform.model.status', 'subscription.get', 'workspace.metrics'])

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== origin) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let method = ''
    if (path === '/mcp' && request.method() === 'POST') method = request.postDataJSON()?.method ?? ''
    requests.push({ path, method: request.method(), rpc: method, versionReadMode })
    if (path === `/v1/tasks/${taskId}/approve` && request.method() === 'POST') {
      approvalWrites.push(request.postDataJSON())
      requestHeld = true
      await heldReply
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ task: { id: taskId, workspaceId, productId: 'product-version-return', platform: 'jd', accountId: 'store-version-return', state: 'approved', contentVersionId: currentId, version: 3, createdAt: '2026-10-10T00:00:00.000Z' }, version: { ...versions[0], state: 'approved', revision: 3 } })) })
      replyFinished = true
      return
    }
    if (path === `/v1/content-versions/${currentId}/export`) {
      requestHeld = true
      await heldReply
      const body = Buffer.from('synthetic verified export; no customer data')
      await route.fulfill({ contentType: 'application/zip', headers: { 'x-delivery-bundle-sha256': `sha256:${createHash('sha256').update(body).digest('hex')}`, 'x-delivery-bundle-verified': 'true', 'content-disposition': 'attachment; filename="old-task.zip"' }, body })
      replyFinished = true
      return
    }
    if (path === `/v1/tasks/task-next-fixture`) return route.fulfill({ json: envelope({ id: 'task-next-fixture', workspaceId, productId: 'product-version-return', platform: 'jd', accountId: 'store-version-return', state: 'review_required', contentVersionId: 'next-content', version: 1, createdAt: '2026-10-10T00:00:00.000Z' }) })
    if (path === '/v1/tasks/task-next-fixture/content-versions') return route.fulfill({ json: envelope({ items: [{ ...versions[0], id: 'next-content', taskId: 'task-next-fixture', body: { ...versions[0].body, title: '另一个任务当前内容' } }], total: 1, limit: 50, offset: 0 }) })
    if (['/v1/tasks/task-next-fixture/timeline', '/v1/tasks/task-next-fixture/directions'].includes(path)) return route.fulfill({ json: envelope([]) })
    if (path === '/v1/content-versions/next-content/review') return route.fulfill({ json: envelope({ findings: [], categories: [{ id: 'next-review', name: '本地版本检查', status: 'passed', findingCount: 0, summary: '另一个任务检查结果' }], blocking: false }) })
    const allowedMcpRead = path === '/mcp' && request.method() === 'POST' && readOnlyMcpMethods.has(method)
    if (request.method() !== 'GET' && !(path === '/v1/auth/mcp-token' && request.method() === 'POST') && !allowedMcpRead) {
      writeAttempts.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '版本查看 fixture 禁止写入' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'task-version-return-user', login: 'version-return@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (path === `/v1/tasks/${taskId}`) data = { id: taskId, workspaceId, productId: 'product-version-return', platform: 'jd', accountId: 'store-version-return', state: exporting ? 'approved' : 'review_required', contentVersionId: currentId, version: 2, createdAt: '2026-10-10T00:00:00.000Z' }
    else if (path === `/v1/tasks/${taskId}/content-versions`) {
      if (versionReadMode === 'failed') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'VERSION_LIST_UNAVAILABLE', message: '内容版本读取暂不可用' })) })
      const items = exporting ? versions.map(item => item.id === currentId ? { ...item, state: 'approved' } : item) : versionReadMode === 'empty' ? [] : versions.map(item => ['pointed', 'task-approved-return'].includes(scenario) && item.id === oldId ? { ...item, state: 'approved' } : item)
      data = { items, total: items.length, limit: 50, offset: 0 }
    }
    else if (path === `/v1/tasks/${taskId}/directions`) data = []
    else if (path === `/v1/tasks/${taskId}/feedback`) data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/timeline`) data = []
    else if (path === `/v1/content-versions/${oldId}/review` || path === `/v1/content-versions/${currentId}/review`) {
      const id = path.includes(oldId) ? oldId : currentId
      reviewReads.push(id)
      if (reviewUnavailable) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'REVIEW_UNAVAILABLE', message: '检查结果暂不可用' })) })
      data = { findings: scenario === 'review-warning' || scenario === 'review-blocked' ? [{ code: 'REVIEW_FIXTURE', priority: 'P1', status: 'open', field: 'title', severity: scenario === 'review-blocked' ? 'error' : 'warning', message: '合成检查结果', repairSuggestion: '核对后确认' }] : [], categories: [{ id: `review-${id}`, name: '本地版本检查', status: 'passed', findingCount: 0, summary: `已核对 ${id}` }], blocking: false }
    } else if (/^\/v1\/products\/[^/]+$/u.test(path)) data = { id: 'product-version-return', workspaceId, platform: 'jd', accountId: 'store-version-return', storeName: '版本返回合成店铺', title: '版本返回合成商品', version: 1, factsConfirmed: true, source: 'browser_fixture', ...(scenario === 'sku-null' ? { skuCount: null } : scenario === 'sku-zero' ? { skuCount: 0 } : scenario === 'sku-count' ? { skuCount: 3 } : scenario === 'sku-invalid' ? { skuCount: -1 } : {}), updatedAt: '2026-10-10T00:00:00.000Z' }
    else if (path === '/mcp') data = { result: method === 'workspace.metrics'
      ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${origin}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const editor = page.getByRole('region', { name: '内容编辑区' })
    await expect(editor.getByRole('heading', { name: '当前内容版本标题' }).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(`已核对 ${currentId}`)).toBeVisible()
    if (exporting) await page.getByRole('button', { name: '导出已审核交付包', exact: true }).click()
    else await page.locator('.approval-box input[type=checkbox]').click()
    await expect.poll(() => requestHeld).toBe(true)
    if (switchTask) {
      await page.evaluate(() => { history.pushState(null, '', '/merchant/tasks/task-next-fixture'); window.dispatchEvent(new PopStateEvent('popstate')) })
      await expect(editor.getByRole('heading', { name: '另一个任务当前内容' }).first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('另一个任务检查结果')).toBeVisible()
    } else if (switchVersion) {
      await page.getByRole('tab', { name: /版本记录/u }).click()
      await page.getByRole('tabpanel', { name: /版本记录/u }).getByRole('button', { name: '查看版本' }).nth(1).click()
      await expect(editor.getByRole('heading', { name: '历史内容版本标题' }).first()).toBeVisible()
      await expect(page.getByText(`已核对 ${oldId}`)).toBeVisible()
    }
    const reply = page.waitForResponse(response => response.url().includes(exporting ? `/${currentId}/export` : `/${taskId}/approve`))
    releaseReply()
    await (await reply).finished()
    await expect.poll(() => replyFinished).toBe(true)
    // Flush the response handlers and digest before inspecting absence of a side effect.
    await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 200)); await new Promise(requestAnimationFrame) })
    await expect(editor.getByRole('heading', { name: switchTask ? '另一个任务当前内容' : switchVersion ? '历史内容版本标题' : '当前内容版本标题' }).first()).toBeVisible()
    await expect(page.getByText(switchTask ? '另一个任务检查结果' : `已核对 ${switchVersion ? oldId : currentId}`)).toBeVisible()
    expect(await page.evaluate(() => window.fixtureDownloads)).toEqual(!switchTask && !switchVersion ? ['old-task.zip'] : [])
    await expect(page.getByText(/导出已生成/)).toHaveCount(!switchTask && !switchVersion ? 1 : 0)
    if (!switchTask && !switchVersion) await expect(page.locator('.approval-box input[type=checkbox]')).toBeChecked()
    else await expect(page.locator('.approval-box input[type=checkbox]')).not.toBeChecked()
    expect(approvalWrites).toHaveLength(exporting ? 0 : 1)
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
    expect(browserErrors).toEqual([])

  } finally {
    await writeFile(`/tmp/task-late-${scenario}.json`, JSON.stringify({ requests, browserErrors, bodyText: await page.locator('body').innerText() }, null, 2)).catch(() => {})
    releaseReply()
    await page.unrouteAll({ behavior: 'wait' }).catch(() => {})
    try {
      if (process.env.TASK_VERSION_REVIEW_ARTIFACTS) {
        const directory = resolve(process.env.TASK_VERSION_REVIEW_ARTIFACTS, scenario)
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: resolve(directory, 'page.png'), fullPage: true })
        if (await page.locator('.task-titlebar').isVisible()) await page.locator('.task-titlebar').screenshot({ path: resolve(directory, 'version-header.png') })
        await writeFile(resolve(directory, 'evidence.json'), JSON.stringify({ scenario, requests, browserErrors, reviewReads, approvalWrites, writeAttempts, externalRequests, bodyText: await page.locator('body').innerText() }, null, 2) + '\n')
      }
    } finally {
      await context.close()
      await browser.close()
      await vite.close()
    }
  }
})
}
