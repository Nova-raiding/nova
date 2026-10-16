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

for (const scenario of ['versions', 'empty', 'failed', 'pointed', 'missing-pointed', 'sku-missing', 'sku-null', 'sku-zero', 'sku-count', 'sku-invalid', 'review-pass', 'review-warning', 'review-blocked', 'review-failed', 'review-recovery', 'task-draft', 'task-ready', 'task-approved-return']) {
test(`content version display preserves ${scenario} evidence and current-version identity`, async () => {
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
    if (scenario === 'task-ready' && path === `/v1/tasks/${taskId}/approve` && request.method() === 'POST') {
      const body = request.postDataJSON()
      approvalWrites.push(body)
      expect(body).toEqual({ content_version_id: oldId })
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ task: { id: taskId, workspaceId, productId: 'product-version-return', platform: 'jd', accountId: 'store-version-return', state: 'approved', contentVersionId: oldId, version: 3, createdAt: '2026-10-10T00:00:00.000Z' }, version: { ...versions[1], state: 'approved', revision: 3 } })) })
    }
    const allowedMcpRead = path === '/mcp' && request.method() === 'POST' && readOnlyMcpMethods.has(method)
    if (request.method() !== 'GET' && !(path === '/v1/auth/mcp-token' && request.method() === 'POST') && !allowedMcpRead) {
      writeAttempts.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '版本查看 fixture 禁止写入' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'task-version-return-user', login: 'version-return@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (path === `/v1/tasks/${taskId}`) data = { id: taskId, workspaceId, productId: 'product-version-return', platform: 'jd', accountId: 'store-version-return', state: ['pointed', 'task-approved-return'].includes(scenario) ? 'approved' : scenario === 'task-ready' || scenario.startsWith('review-') ? 'review_required' : 'draft', ...(['pointed', 'task-approved-return'].includes(scenario) ? { contentVersionId: oldId } : scenario === 'missing-pointed' ? { contentVersionId: 'missing-version-fixture' } : {}), version: 2, createdAt: '2026-10-10T00:00:00.000Z' }
    else if (path === `/v1/tasks/${taskId}/content-versions`) {
      if (versionReadMode === 'failed') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'VERSION_LIST_UNAVAILABLE', message: '内容版本读取暂不可用' })) })
      const items = versionReadMode === 'empty' ? [] : versions.map(item => ['pointed', 'task-approved-return'].includes(scenario) && item.id === oldId ? { ...item, state: 'approved' } : item)
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
    if (scenario === 'empty') {
      await expect(page.locator('.task-meta').getByText('内容版本尚未生成', { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('button', { name: '尚无内容版本', exact: true })).toBeDisabled()
      await expect(page.locator('.task-meta')).not.toContainText('v0')
      expect(writeAttempts).toEqual([])
      expect(externalRequests).toEqual([])
      return
    }
    if (scenario === 'missing-pointed') {
      await expect(page.getByTestId('context-recovery-card')).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('.task-meta')).toContainText('内容版本未确认')
      await expect(page.getByRole('region', { name: '内容编辑区' })).toHaveCount(0)
      expect(writeAttempts).toEqual([])
      expect(externalRequests).toEqual([])
      return
    }
    if (scenario === 'failed') {
      await expect(page.getByTestId('context-recovery-card')).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('.task-meta').getByText('内容版本未确认', { exact: true })).toBeVisible()
      await expect(page.locator('.task-meta')).not.toContainText('v0')
      const previousVersionReads = requests.filter(request => request.path.endsWith('/content-versions')).length
      versionReadMode = 'versions'
      await page.getByRole('button', { name: '重新加载任务', exact: true }).click()
      await expect.poll(() => requests.filter(request => request.path.endsWith('/content-versions')).length).toBeGreaterThan(previousVersionReads)
    }
    const editor = page.getByRole('region', { name: '内容编辑区' })
    if (scenario === 'task-approved-return') {
      const approval = page.locator('.approval-box input[type=checkbox]')
      await expect(editor.getByRole('heading', { name: '历史内容版本标题' }).first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(`已核对 ${oldId}`)).toBeVisible()
      await expect(approval).toBeChecked()
      await page.getByRole('tab', { name: /版本记录/u }).click()
      const history = page.getByRole('tabpanel', { name: /版本记录/u })
      await history.getByRole('button', { name: '查看版本' }).first().click()
      await expect(page.getByText(`已核对 ${currentId}`)).toBeVisible()
      await expect(approval).not.toBeChecked()
      await expect(approval).toBeDisabled()
      await page.getByRole('tab', { name: /版本记录/u }).click()
      await history.getByRole('button', { name: '查看版本' }).nth(1).click()
      await expect(page.getByText(`已核对 ${oldId}`)).toBeVisible()
      await expect(approval).toBeChecked()
      await expect(approval).toBeDisabled()
      expect(writeAttempts).toEqual([])
      expect(externalRequests).toEqual([])
      return
    }
    if (scenario === 'pointed') {
      await expect(editor.getByRole('heading', { name: '历史内容版本标题' }).first()).toBeVisible({ timeout: 30_000 })
      await expect(editor.getByRole('button', { name: /v1\s*正在查看/u })).toBeVisible()
      await page.getByRole('tab', { name: /版本记录/u }).click()
      const pointedHistory = page.getByRole('tabpanel', { name: /版本记录/u })
      await expect(pointedHistory.locator('.version-row').first()).toContainText('最新版本')
      await expect(pointedHistory.locator('.version-row').nth(1)).toContainText('任务关联版本')
      await expect(pointedHistory.locator('.version-row').nth(1)).toContainText('正在查看')
      expect(writeAttempts).toEqual([])
      expect(externalRequests).toEqual([])
      return
    }
    await expect(editor.getByRole('heading', { name: '当前内容版本标题' }).first()).toBeVisible({ timeout: 30_000 })
    await expect(editor.getByRole('button', { name: /v2\s*正在查看/u })).toBeVisible()
    if (['task-draft', 'task-ready'].includes(scenario)) {
      await expect(page.getByText(`已核对 ${currentId}`)).toBeVisible()
      const approval = page.locator('.approval-box input[type=checkbox]')
      if (scenario === 'task-draft') {
        await expect(approval).toBeDisabled()
        await expect(page.locator('.approval-box')).toContainText('当前任务不在待审核阶段')
        await expect(page.getByTestId('task-result-card')).toContainText('当前任务不在待审核阶段')
      } else {
        await expect(approval).toBeEnabled()
        await page.getByRole('tab', { name: /版本记录/u }).click()
        await page.getByRole('tabpanel', { name: /版本记录/u }).getByRole('button', { name: '查看版本' }).nth(1).click()
        await expect(page.getByText(`已核对 ${oldId}`)).toBeVisible()
        await expect(approval).toBeEnabled()
        await approval.click()
        await expect(approval).toBeChecked()
        await expect(approval).toBeDisabled()
        await expect(page.getByRole('button', { name: '继续确认发布', exact: true })).toBeEnabled()
        expect(approvalWrites).toEqual([{ content_version_id: oldId }])
      }
      expect(writeAttempts).toEqual([])
      expect(externalRequests).toEqual([])
      return
    }
    if (scenario.startsWith('review-')) {
      const review = page.locator('.review-score')
      const status = ['review-failed', 'review-recovery'].includes(scenario) ? '待确认' : scenario === 'review-blocked' ? '有阻断' : scenario === 'review-warning' ? '有建议' : '无阻断'
      await expect.poll(() => reviewReads.length).toBeGreaterThan(0)
      await expect(review.locator('.review-check-status')).toHaveText(status)
      await expect(review).toContainText('规则检查')
      await expect(review).not.toContainText('/100')
      await expect(review).not.toContainText('审核评分')
      if (scenario === 'review-blocked') await expect(review).toContainText('1 项阻断')
      if (scenario === 'review-warning') await expect(review).toContainText('1 项建议')
      if (['review-failed', 'review-recovery'].includes(scenario)) {
        await expect(page.getByText(/审核结果读取失败/)).toBeVisible()
        await expect(page.locator('.finding-list')).toContainText('检查结果尚未确认')
        await expect(page.locator('.finding-list')).not.toContainText('服务端检查通过')
        await expect(page.getByTestId('task-result-card')).toContainText('检查结果尚未确认')
        await expect(page.getByTestId('task-result-card')).not.toContainText('已完成服务端检查')
      }
      if (scenario === 'review-recovery') {
        const previousReads = reviewReads.length
        reviewUnavailable = false
        await page.locator('.review-panel').getByRole('button', { name: '重新读取', exact: true }).click()
        await expect.poll(() => reviewReads.length).toBeGreaterThan(previousReads)
        await expect(review.locator('.review-check-status')).toHaveText('无阻断')
        await expect(page.locator('.review-panel')).not.toContainText('审核结果读取失败')
        await expect(page.locator('.finding-list')).toContainText('服务端检查通过，暂无发现项')
        await expect(page.getByTestId('task-result-card')).toContainText('已完成服务端检查')
        await expect(page.getByTestId('task-result-card')).not.toContainText('检查结果尚未确认')
      }
      expect(writeAttempts).toEqual([])
      expect(externalRequests).toEqual([])
      return
    }
    if (scenario.startsWith('sku-')) {
      const benefits = page.getByRole('region', { name: '商品详情页预览' }).locator('.storefront-benefits')
      const expected = scenario === 'sku-zero' ? '0 个 SKU' : scenario === 'sku-count' ? '3 个 SKU' : 'SKU 数量待确认'
      await expect(benefits.getByText(expected, { exact: true })).toBeVisible()
      if (!['sku-zero', 'sku-count'].includes(scenario)) await expect(benefits).not.toContainText('0 个 SKU')
      expect(writeAttempts).toEqual([])
      expect(externalRequests).toEqual([])
      return
    }

    const knowledge = page.getByTestId('task-knowledge-consumption')
    await expect(knowledge).toContainText('未返回记录')
    await expect(knowledge).not.toContainText('0 条已冻结')
    await page.getByRole('tab', { name: /版本记录/u }).click()
    const history = page.getByRole('tabpanel', { name: /版本记录/u })
    await expect(history.getByText('内容版本 v1')).toBeVisible()
    await history.getByRole('button', { name: '查看版本' }).nth(1).click()
    await expect(editor.getByRole('heading', { name: '历史内容版本标题' }).first()).toBeVisible()
    await expect(page.getByText(`已核对 ${oldId}`)).toBeVisible()
    await expect(editor.getByRole('button', { name: /v1\s*正在查看/u })).toBeVisible()
    await expect(knowledge).toContainText('0 条已冻结')

    await page.getByRole('tab', { name: /版本记录/u }).click()
    await expect(history.locator('.version-row').first()).toContainText('最新版本')
    await expect(history.locator('.version-row').nth(1)).toContainText('历史版本')
    await history.getByRole('button', { name: '查看版本' }).first().click()
    await expect(editor.getByRole('heading', { name: '当前内容版本标题' }).first()).toBeVisible()
    await expect(page.getByText(`已核对 ${currentId}`)).toBeVisible()
    await expect(knowledge).toContainText('未返回记录')
    await expect(knowledge).not.toContainText('0 条已冻结')
    expect(reviewReads).toContain(oldId)
    expect(reviewReads).toContain(currentId)
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
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
