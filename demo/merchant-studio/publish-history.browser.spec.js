import { expect, test, chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:5188'
const evidenceDir = process.env.PUBLISH_HISTORY_EVIDENCE_DIR
const workspaceId = 'ws_publish_history_local_mock'

const envelope = (data, error = null) => ({
  request_id: 'local-publish-history', trace_id: 'local-publish-history',
  workspace_id: workspaceId, data, warnings: [], next_actions: [], error,
})

const job = (index, overrides = {}) => ({
  id: `pub-${index}`, workspaceId, taskId: `task-${index}`, contentVersionId: `version-${index}`,
  platform: 'taobao', accountId: 'store-1', idempotencyKey: `key-${index}`,
  state: 'queued', confirmationHash: 'confirmation', remoteSnapshotHash: 'snapshot',
  createdAt: '2026-09-29T08:00:00.000Z', ...overrides,
})

const report = index => ({
  id: `manual-${index}`, workspaceId, taskId: `task-${index}`, contentVersionId: `version-${index}`,
  platform: 'taobao', accountId: 'store-1', state: 'manual_publish_reported',
  evidenceBoundary: 'manual_unverified', recordedAt: '2026-09-29T09:00:00.000Z',
})

async function openMock({ empty = false, failFirst = false, failOnAttempt = 0, failJobOffsets = [], failManualOffsets = [], failFocusedRefresh = false, shrinkOnRefresh = false, focusJobId = '', delayJobs = 0, dynamicService = false } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const observations = { jobOffsets: [], manualOffsets: [], focusedJobIds: [], jobAttempts: 0, manualAttempts: 0, unexpectedWrites: [] }
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const parsed = new URL(request.url())
    const pathname = parsed.pathname.replace(/^\/api/u, '')
    let data
    if (pathname === '/v1/auth/session') data = { account: { id: 'merchant-mock', login: 'mock@example.invalid', accountType: 'merchant', displayName: '本地验收商家', enterpriseName: '本地验收', status: 'active', workspaceIds: [workspaceId] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: 300 }
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'mock', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (pathname === '/v1/tasks') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (pathname === '/v1/products') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (/^\/v1\/publish-jobs\/[^/]+$/u.test(pathname)) {
      const id = decodeURIComponent(pathname.slice('/v1/publish-jobs/'.length))
      observations.focusedJobIds.push(id)
      if (id === 'pub-42' && failFocusedRefresh && observations.focusedJobIds.length === 2) {
        if (delayJobs > 0) await new Promise(resolve => setTimeout(resolve, delayJobs))
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'PUBLISH_READ_UNAVAILABLE', message: '发布记录暂不可读取' })) })
      }
      if (id === 'pub-42') data = job(42)
      else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'PUBLISH_JOB_NOT_FOUND', message: '发布任务不存在' })) })
    } else if (pathname === '/v1/publish-jobs') {
      const offset = Number(parsed.searchParams.get('offset') ?? 0)
      observations.jobOffsets.push(offset)
      observations.jobAttempts++
      if (delayJobs > 0) await new Promise(resolve => setTimeout(resolve, delayJobs))
      if ((failFirst && observations.jobAttempts === 1) || (failOnAttempt > 0 && observations.jobAttempts === failOnAttempt) || failJobOffsets.includes(offset)) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'PUBLISH_READ_UNAVAILABLE', message: '发布记录暂不可读取' })) })
      data = empty ? { items: [], total: 0, limit: 20, offset } : {
        items: offset === 0
          ? Array.from({ length: 20 }, (_, i) => job(i + 1, i === 0 ? { state: 'rejected', remoteState: 'rejected', rejection: { rawCode: 'PLATFORM_422', message: '标题不合规', fields: [{ path: 'title', rawCode: 'TITLE_42', message: '含违禁词' }] } } : {}))
          : [job(21, { state: 'unknown', remoteState: 'unknown' })],
        total: 21, limit: 20, offset,
      }
    } else if (pathname === '/mcp') {
      const body = request.postDataJSON()
      if (body.method === 'publish.manual.list') {
        const offset = Number(body.params.offset ?? 0)
        observations.manualOffsets.push(offset)
        observations.manualAttempts++
        if (failManualOffsets.includes(offset)) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'PUBLISH_READ_UNAVAILABLE', message: '发布记录暂不可读取' })) })
        if (shrinkOnRefresh && observations.manualAttempts > 6) {
          data = { result: { items: offset === 20 ? [report(21), report(22), report(23), report(24), report(25)] : [], total: 25, limit: 20, offset } }
        } else data = { result: empty ? { items: [], total: 0, limit: 20, offset } : {
          items: offset === 100 ? [report(101)] : Array.from({ length: 20 }, (_, i) => report(offset + i + 1)),
          total: 101, limit: 20, offset,
        } }
      } else data = { result: { items: [], total: 0, limit: 50, offset: 0 } }
    } else data = { items: [], total: 0, limit: 50, offset: 0 }
    if (request.method() !== 'GET' && !['/mcp', '/v1/auth/mcp-token'].includes(pathname)) observations.unexpectedWrites.push(`${request.method()} ${pathname}`)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })
  // Isolated local candidate mount: the browser sees the production panel
  // component, while all backend responses are controlled read-only mocks.
  const query = new URLSearchParams()
  if (focusJobId) query.set('publish_job_id', focusJobId)
  if (dynamicService) query.set('test_service_toggle', '1')
  await page.goto(`${studioUrl}/publish-history-visual.html${query.size ? `?${query}` : ''}`, { waitUntil: 'domcontentloaded' })
  return { browser, context, page, observations, pageErrors }
}

async function screenshot(page, name) {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true })
  await page.locator('section[aria-label="发布记录"]').screenshot({ path: join(evidenceDir, name) })
}

test('桌面任务队列可查看两类发布记录、驳回字段和第 101 条人工报告', async () => {
  const { browser, context, page, observations, pageErrors } = await openMock()
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('平台原始拒绝码：PLATFORM_422')
    await expect(panel).toContainText('标题（原始字段 title）；原始代码 TITLE_42；含违禁词')
    await expect(panel.getByRole('link', { name: '查看任务与纠错' }).first()).toHaveAttribute('href', /\/merchant\/tasks\/task-1$/u)
    await screenshot(page, '01-发布任务驳回.png')
    await panel.getByRole('button', { name: '下一页' }).click()
    await expect(panel).toContainText('结果未知，需人工核对')
    await expect(panel).toContainText('当前不要重复提交')
    await screenshot(page, '02-发布任务第二页.png')
    await panel.getByRole('tab', { name: '人工发布报告' }).click()
    await expect(panel).toContainText('未经平台接口验证，不代表平台已发布')
    for (let i = 0; i < 5; i++) await panel.getByRole('button', { name: '下一页' }).click()
    await expect(panel).toContainText('任务 task-101')
    await expect(panel).toContainText('第 6 / 6 页，共 101 条')
    await screenshot(page, '03-人工报告第101条.png')
    expect(observations.jobOffsets).toEqual([0, 20])
    expect(observations.manualOffsets).toEqual([0, 20, 40, 60, 80, 100])
    expect(observations.unexpectedWrites).toEqual([])
    expect(pageErrors).toEqual([])
  } finally { await context.close(); await browser.close() }
})

test('发布记录空态可区分两类记录', async () => {
  const { browser, context, page, pageErrors } = await openMock({ empty: true })
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    await expect(panel).toContainText('当前没有发布任务')
    await panel.getByRole('tab', { name: '人工发布报告' }).click()
    await expect(panel).toContainText('当前没有人工发布报告')
    await screenshot(page, '04-人工报告空态.png')
    expect(pageErrors).toEqual([])
  } finally { await context.close(); await browser.close() }
})

test('发布记录类型标签支持左右方向键切换并将焦点移到当前标签', async () => {
  const { browser, context, page, pageErrors } = await openMock()
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    const jobsTab = panel.getByRole('tab', { name: '发布任务' })
    const manualTab = panel.getByRole('tab', { name: '人工发布报告' })
    const jobsPanel = panel.getByRole('tabpanel')
    await expect(jobsTab).toHaveAttribute('aria-controls', await jobsPanel.getAttribute('id'))
    await expect(jobsPanel).toHaveAttribute('aria-labelledby', await jobsTab.getAttribute('id'))
    await expect(jobsTab).toHaveAttribute('tabindex', '0')
    await expect(manualTab).toHaveAttribute('tabindex', '-1')
    await jobsTab.focus()
    await page.keyboard.press('ArrowRight')
    await expect(manualTab).toHaveAttribute('aria-selected', 'true')
    await expect(manualTab).toBeFocused()
    const manualPanel = panel.getByRole('tabpanel')
    await expect(manualTab).toHaveAttribute('aria-controls', await manualPanel.getAttribute('id'))
    await expect(manualPanel).toHaveAttribute('aria-labelledby', await manualTab.getAttribute('id'))
    await expect(manualTab).toHaveAttribute('tabindex', '0')
    await expect(jobsTab).toHaveAttribute('tabindex', '-1')
    await expect(panel).toContainText('未经平台接口验证，不代表平台已发布')
    await page.keyboard.press('ArrowLeft')
    await expect(jobsTab).toHaveAttribute('aria-selected', 'true')
    await expect(jobsTab).toBeFocused()
    await expect(panel).toContainText('平台原始拒绝码：PLATFORM_422')
    await page.keyboard.press('End')
    await expect(manualTab).toBeFocused()
    await expect(manualTab).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Home')
    await expect(jobsTab).toBeFocused()
    await expect(jobsTab).toHaveAttribute('aria-selected', 'true')
    expect(pageErrors).toEqual([])
  } finally { await context.close(); await browser.close() }
})

test('发布记录读取错误显示原始错误并可重试恢复', async () => {
  const { browser, context, page, observations, pageErrors } = await openMock({ failOnAttempt: 2, delayJobs: 350 })
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    await expect(panel).toContainText('平台原始拒绝码：PLATFORM_422')
    await panel.getByRole('button', { name: '刷新记录' }).click()
    await expect(panel.getByText('正在刷新；当前保留上次成功读取的发布记录。')).toBeVisible()
    await expect(panel).toContainText('平台原始拒绝码：PLATFORM_422')
    await expect(panel.getByRole('alert')).toContainText('读取发布记录失败：发布记录暂时无法读取，请检查 API 连接后重试。')
    await expect(panel.getByRole('alert')).not.toContainText('操作未确认')
    await expect(panel.getByRole('alert')).not.toContainText('模型中转')
    await expect(panel.getByText('显示上次成功读取的发布记录；刷新失败，当前状态可能已变化。')).toBeVisible()
    await expect(panel).toContainText('平台原始拒绝码：PLATFORM_422')
    await screenshot(page, '05-读取错误.png')
    await panel.getByRole('button', { name: '重试' }).click()
    await expect(panel).toContainText('平台原始拒绝码：PLATFORM_422')
    expect(observations.jobAttempts).toBe(3)
    expect(pageErrors).toEqual([])
  } finally { await context.close(); await browser.close() }
})

test('切换分页读取失败时明确标注仍显示的旧页记录', async () => {
  const { browser, context, page, observations, pageErrors } = await openMock({ failJobOffsets: [20], failManualOffsets: [20] })
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    await expect(panel).toContainText('任务 task-1')
    await panel.getByRole('button', { name: '下一页' }).click()
    await expect(panel.getByRole('alert')).toContainText('读取发布记录失败：发布记录暂时无法读取，请检查 API 连接后重试。')
    await expect(panel.getByText('显示第 1 页的上次成功数据；第 2 页读取失败。')).toBeVisible()
    await expect(panel).toContainText('显示第 1 页（第 2 页读取失败），共 21 条')
    await expect(panel).toContainText('任务 task-1')
    await expect(panel).not.toContainText('任务 task-21')

    await panel.getByRole('tab', { name: '人工发布报告' }).click()
    await expect(panel).toContainText('任务 task-1')
    await panel.getByRole('button', { name: '下一页' }).click()
    await expect(panel.getByRole('alert')).toContainText('读取发布记录失败：发布记录暂时无法读取，请检查 API 连接后重试。')
    await expect(panel.getByText('显示第 1 页的上次成功数据；第 2 页读取失败。')).toBeVisible()
    await expect(panel).toContainText('显示第 1 页（第 2 页读取失败），共 101 条')
    await expect(panel).toContainText('任务 task-1')
    await expect(panel).not.toContainText('任务 task-21')
    expect(observations.jobOffsets).toEqual([0, 20])
    expect(observations.manualOffsets).toEqual([0, 20])
    expect(observations.unexpectedWrites).toEqual([])
    expect(pageErrors).toEqual([])
  } finally { await context.close(); await browser.close() }
})

test('服务配置在读取中失效时退出加载态并清除旧发布记录', async () => {
  const { browser, context, page, pageErrors } = await openMock({ delayJobs: 700, dynamicService: true })
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    await expect(panel.getByRole('status')).toContainText('正在读取发布记录')
    await page.getByRole('button', { name: '切换服务配置' }).click()
    await expect(panel.getByRole('status')).toContainText('配置服务端后可读取真实发布记录')
    await expect(panel).not.toContainText('正在读取发布记录')
    await page.getByRole('button', { name: '切换服务配置' }).click()
    await expect(panel).toContainText('平台原始拒绝码：PLATFORM_422')
    expect(pageErrors).toEqual([])
  } finally { await context.close(); await browser.close() }
})

test('刷新后总数缩小时自动回到最后有效页', async () => {
  const { browser, context, page, observations } = await openMock({ shrinkOnRefresh: true })
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    await panel.getByRole('tab', { name: '人工发布报告' }).click()
    for (let i = 0; i < 5; i++) await panel.getByRole('button', { name: '下一页' }).click()
    await expect(panel).toContainText('第 6 / 6 页，共 101 条')
    await panel.getByRole('button', { name: '刷新记录' }).click()
    await expect(panel).toContainText('第 2 / 2 页，共 25 条')
    await expect(panel).toContainText('任务 task-25')
    await expect(panel).not.toContainText('读取失败）')
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '下一页' })).toBeDisabled()
    expect(observations.manualOffsets.slice(-2)).toEqual([100, 20])
  } finally { await context.close(); await browser.close() }
})

test('发布任务深链按 ID 读取，不受最近 20 条分页限制', async () => {
  const { browser, context, page, observations, pageErrors } = await openMock({ focusJobId: 'pub-42' })
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    await expect(panel).toContainText('刚创建的发布任务：pub-42')
    await expect(panel).toContainText('任务 task-42')
    await expect(panel).not.toContainText('任务 task-1')
    expect(observations.focusedJobIds).toEqual(['pub-42'])
    expect(observations.jobOffsets).toEqual([])
    expect(observations.unexpectedWrites).toEqual([])
    expect(pageErrors).toEqual([])
  } finally { await context.close(); await browser.close() }
})

test('发布任务深链刷新失败时保留当前任务快照并可重试', async () => {
  const { browser, context, page, observations, pageErrors } = await openMock({ focusJobId: 'pub-42', failFocusedRefresh: true, delayJobs: 250 })
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    await expect(panel).toContainText('刚创建的发布任务：pub-42')
    await panel.getByRole('button', { name: '刷新记录' }).click()
    await expect(panel.getByText('正在刷新；当前保留上次成功读取的发布记录。')).toBeVisible()
    await expect(panel).toContainText('刚创建的发布任务：pub-42')
    await expect(panel.getByRole('alert')).toContainText('无法读取指定发布任务 pub-42')
    await expect(panel.getByText('显示上次成功读取的发布记录；刷新失败，当前状态可能已变化。')).toBeVisible()
    await expect(panel).toContainText('刚创建的发布任务：pub-42')
    await panel.getByRole('button', { name: '重试' }).click()
    await expect(panel).toContainText('刚创建的发布任务：pub-42')
    expect(observations.focusedJobIds).toEqual(['pub-42', 'pub-42', 'pub-42'])
    expect(pageErrors).toEqual([])
  } finally { await context.close(); await browser.close() }
})

test('不可达的发布任务深链明确报错，不回退显示普通首页', async () => {
  const { browser, context, page, observations, pageErrors } = await openMock({ focusJobId: 'pub-missing' })
  try {
    const panel = page.getByRole('region', { name: '发布记录' })
    await expect(panel.getByRole('alert')).toContainText('无法读取指定发布任务 pub-missing')
    await expect(panel).not.toContainText('任务 task-1')
    await expect(panel.getByRole('link', { name: '返回发布记录列表' })).toHaveAttribute('href', /\/merchant\/tasks$/u)
    expect(observations.focusedJobIds).toEqual(['pub-missing'])
    expect(observations.jobOffsets).toEqual([])
    expect(observations.unexpectedWrites).toEqual([])
    expect(pageErrors).toEqual([])
  } finally { await context.close(); await browser.close() }
})
