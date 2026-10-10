import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081'
let browserDiagnostics = []
let unexpectedApiRequests = []
const envelope = (data) => ({
  request_id: 'browser-image-request',
  trace_id: 'browser-image-trace',
  workspace_id: 'ws_demo',
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

const baseJob = (overrides = {}) => ({
  job_id: 'job_image_matrix',
  revision: 3,
  state: 'succeeded',
  archive_state: 'archived',
  product_id: 'product_1',
  task_id: 'task_1',
  content_version_id: 'content_1',
  image_mode: 'create',
  direction: '干净背景',
  requested_count: 1,
  source_asset_ids: ['asset_1'],
  source_product_version: 2,
  intent_hash: 'a'.repeat(64),
  execution_state: 'succeeded',
  provider_request_id: 'provider_1',
  execution_attempt: 1,
  reconciliation_required: false,
  error_code: null,
  error_message: null,
  updated_at: '2026-09-01T08:00:00.000Z',
  created_at: '2026-09-01T07:59:00.000Z',
  outputs: [],
  images: [],
  availability_warning: null,
  next_action: { type: 'select', label: '选择主图', allowed: true },
  ...overrides,
})

const output = (overrides = {}) => ({
  visual_ref: 'visual_1',
  ordinal: 1,
  asset_id: 'asset_generated_1',
  archive_receipt_id: 'archive_1',
  archive_receipt_digest: 'b'.repeat(64),
  storage_key: 'clean/ws_demo/asset_generated_1.webp',
  mime_type: 'image/webp',
  size_bytes: 1024,
  sha256: 'c'.repeat(64),
  created_at: '2026-09-01T08:00:00.000Z',
  review_status: 'passed',
  gate: {
    archive: 'archived',
    scan: 'clean',
    rights: 'approved',
    authenticity: 'verified',
    selectable: true,
    blockers: [],
  },
  ...overrides,
})

test.afterEach(async ({}, testInfo) => {
  const report = JSON.stringify(browserDiagnostics, null, 2)
  await testInfo.attach('browser-diagnostics.json', { body: Buffer.from(report), contentType: 'application/json' })
  console.log(`BROWSER_DIAGNOSTICS ${report}`)
  expect(unexpectedApiRequests, 'all browser API requests must use an explicit fixture').toEqual([])
})

async function installApiRoutes(page, { jobs = [], detail, details, retryJob, retryFailureOnce = false, imageFailureOnce = false, detailDelayMs = 0, detailDelayByJob = {} } = {}) {
  unexpectedApiRequests = []
  let retryFailed = false
  // Unmodeled API calls fail closed instead of receiving an empty success that
  // could hide an endpoint or contract change.
  await page.route('**/v1/**', route => {
    unexpectedApiRequests.push(route.request().url())
    return route.fulfill({ status: 501,
    contentType: 'application/json',
    body: JSON.stringify(envelope(null, { code: 'UNMOCKED_BROWSER_API', message: 'No fixture was declared for this API request.' })),
  })
  })
  await page.route('**/v1/auth/session', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ account: {
      id: 'merchant_qa',
      login: 'merchant-qa@example.invalid',
      accountType: 'merchant',
      status: 'active',
      roles: ['merchant_owner'],
      displayName: '商家 QA',
      workspaceIds: ['ws_demo'],
    } })),
  }))
  await page.route('**/v1/auth/mcp-token', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ access_token: 'image-fixture-token', refresh_token: 'image-fixture-refresh', token_type: 'Bearer', expires_in: 3600, workspace_id: 'ws_demo', account_login: 'merchant-qa@example.invalid' })),
  }))
  await page.route('**/healthz', route => route.fulfill({
    contentType: 'application/json',
    // All server-facing responses in this UI exercise are intercepted below.
    body: JSON.stringify(envelope({ status: 'ok', writesEnabled: true, connectors: {}, persistence: { mode: 'fixture', ready: true } })),
  }))
  await page.route('**/mcp', async route => {
    const body = route.request().postDataJSON?.() ?? {}
    if (body.method === 'catalog.image.retry' && retryFailureOnce && !retryFailed) {
      retryFailed = true
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ...envelope(null), error: { code: 'IMAGE_RETRY_UNAVAILABLE', message: '重试请求暂时不可用' } }) })
    }
    const result = body.method === 'platform.model.status'
      ? { state: 'ready', capabilities: { image_generation: true, image_editing: true }, next_actions: [] }
      : body.method === 'workspace.metrics'
        ? { riskItems: [] }
      : body.method === 'content.visual.select'
        ? { content_version_id: 'content_2', parent_content_version_id: 'content_1', version: 2, revision: 4, state: 'review_required', visualSelection: { state: 'selected', count: 1, items: [{ visualRef: 'visual_1', ordinal: 1, reviewStatus: 'passed', publishable: false }] }, reviewRequired: true, approvalRequired: true }
        : body.method === 'catalog.image.retry'
          ? (retryJob ?? { job_id: 'job_image_retry', previous_job_id: 'job_image_matrix', state: 'queued' })
          : { state: 'ready' }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
  })
  await page.route('**/v1/image-generation-jobs?*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: jobs, total: jobs.length, limit: 50, offset: 0 })),
  }))
  await page.route('**/v1/publish-jobs*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) }))
  await page.route('**/v1/image-generation-jobs/*', async route => {
    const requestJobId = new URL(route.request().url()).pathname.split('/').pop()
    const responseDetail = details?.[requestJobId] ?? detail
    const configuredDelay = detailDelayByJob[requestJobId]
    const delayMs = Array.isArray(configuredDelay) ? (configuredDelay.shift() ?? 0) : configuredDelay ?? detailDelayMs
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    if (!responseDetail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null)) })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(responseDetail)) })
  })
  let imageFailed = false
  await page.route('**/candidate-1.webp', route => {
    if (imageFailureOnce && !imageFailed) {
      imageFailed = true
      return route.fulfill({ status: 500, body: 'candidate unavailable' })
    }
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>' })
  })
  await page.route('**/v1/tasks?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 12, offset: 0 })) }))
  await page.route('**/v1/tasks/task_1/content-versions?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope([{ id: 'content_1', revision: 3, version: 1, state: 'review_required' }])) }))
  await page.route('**/v1/tasks/task_1/content-versions', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope([{ id: 'content_1', revision: 3, version: 1, state: 'review_required' }])) }))
  await page.route('**/v1/task-groups*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) }))
  await page.route('**/v1/workspaces/*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ riskItems: [], items: [] })) }))
}

test('keeps the desktop candidate area occupied while the first task read is pending', async () => {
  const detail = baseJob({ outputs: [output()], images: ['data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'] })
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix', { detail, detailDelayMs: 400 })
  try {
    const panel = page.locator('.image-generation-job-panel')
    await expect(panel).toHaveAttribute('aria-busy', 'true')
    await expect(panel.locator('.image-candidate-skeleton')).toHaveCount(3)
    await expect(panel.locator('.image-candidate-skeleton-media').first()).toHaveCSS('aspect-ratio', '4 / 3')
    await expect(panel.getByText('正在读取任务状态…')).toBeVisible()
    await expect(panel.locator('.image-candidate-skeleton')).toHaveCount(0)
    await expect(panel.getByRole('img', { name: /图片候选 1/ })).toBeVisible()
  } finally {
    await context.close(); await browser.close()
  }
})

async function openPage(path, setup) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(8_000)
  const page = await context.newPage()
  browserDiagnostics = []
  page.on('console', message => browserDiagnostics.push({ type: 'console', level: message.type(), text: message.text() }))
  page.on('pageerror', error => browserDiagnostics.push({ type: 'pageerror', text: error.message }))
  page.on('requestfailed', request => browserDiagnostics.push({ type: 'requestfailed', url: request.url(), error: request.failure()?.errorText ?? 'unknown' }))
  await installApiRoutes(page, setup)
  await page.goto(`${studioUrl}${path}`, { waitUntil: 'domcontentloaded' })
  return { browser, context, page }
}

test('renders an explicit empty state when no image jobs exist', async () => {
  const { browser, context, page } = await openPage('/merchant/tasks', { jobs: [] })
  try {
    await expect(page.getByRole('heading', { name: '图片任务' })).toBeVisible()
    await expect(page.getByText('暂无图片任务', { exact: true })).toBeVisible()
    await expect(page.getByText('系统不会自动创建演示任务')).toBeVisible()
  } finally {
    await context.close(); await browser.close()
  }
})

test('shows blocked candidates and keeps selection disabled', async () => {
  const detail = baseJob({
    outputs: [output({ gate: { archive: 'archived', scan: 'quarantined', rights: 'approved', authenticity: 'unverified', selectable: false, blockers: ['安全扫描未通过', '真实性未确认'] } })],
    images: ['data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'],
    next_action: { type: 'wait', label: '等待安全扫描', allowed: false },
  })
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix', { detail })
  try {
    await expect(page.getByRole('heading', { name: '图片生成任务' })).toBeVisible()
    await expect(page.getByText('暂不可选择', { exact: true })).toBeVisible()
    await expect(page.getByText(/不可选择：安全扫描未通过；真实性未确认/)).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /选择为/ })).toBeDisabled()
    await expect(page.getByText('等待安全扫描', { exact: false })).toBeVisible()
  } finally {
    await context.close(); await browser.close()
  }
})

test('surfaces a failed job and exposes only the safe retry recovery', async () => {
  const detail = baseJob({
    state: 'failed',
    archive_state: 'pending',
    execution_state: 'failed',
    error_code: 'IMAGE_GENERATION_PRE_PROVIDER_FAILED',
    error_message: '模型中转暂时不可用',
    outputs: [],
    images: [],
    next_action: { type: 'retry', label: '可以安全重试', allowed: true },
  })
  const retriedJob = baseJob({ job_id: 'job_image_retry', revision: 1, state: 'queued', archive_state: 'pending', execution_state: 'queued', error_code: null, error_message: null, next_action: { type: 'wait', label: '生成已排队', allowed: false } })
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix', { detail, details: { job_image_retry: retriedJob }, retryFailureOnce: true })
  const retryRequests = []
  page.on('request', request => {
    const body = request.postDataJSON?.()
    if (body?.method === 'catalog.image.retry') retryRequests.push(body)
  })
  try {
    await expect(page.getByRole('alert')).toContainText('IMAGE_GENERATION_PRE_PROVIDER_FAILED')
    const retry = page.getByRole('button', { name: '安全重试' })
    await expect(retry).toBeVisible()
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => retryRequests.length, 'safe retry must reach the MCP fixture once').toBe(1)
    const retryError = page.locator('#image-job-retry-error')
    await expect(retryError).toContainText('安全重试结果未确认')
    await expect(retryError).toContainText('服务端没有返回确认')
    await expect(page.locator('#image-job-read-error')).toHaveCount(0)
    expect(retryRequests).toHaveLength(1)

    await retry.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('任务 job_image_retry · 商品 product_1', { exact: false })).toBeVisible()
    await expect(page.locator('#image-job-retry-error')).toHaveCount(0)
    expect(retryRequests).toHaveLength(2)
    expect(retryRequests[0]).toMatchObject({ method: 'catalog.image.retry', params: { job_id: 'job_image_matrix', expected_revision: '3', idempotency_key: 'merchant-studio-image-retry-job_image_matrix-3' } })
    expect(retryRequests[1]?.params).toEqual(retryRequests[0]?.params)
  } finally {
    await context.close(); await browser.close()
  }
})

test('does not offer retry when the image provider outcome is uncertain', async () => {
  const detail = baseJob({
    state: 'failed',
    archive_state: 'pending',
    execution_state: 'outcome_unknown',
    reconciliation_required: true,
    error_code: 'IMAGE_GENERATION_PRE_PROVIDER_FAILED',
    error_message: '模型请求结果暂未确认',
    next_action: { type: 'retry', label: '来源不可信的重试提示', allowed: true },
  })
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix', { detail })
  try {
    await expect(page.getByRole('alert').filter({ hasText: '模型结果尚未确认；请先对账，系统不会再次生成或扣费。' }))
      .toContainText('模型结果尚未确认；请先对账，系统不会再次生成或扣费。')
    await expect(page.getByRole('button', { name: '安全重试' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '刷新图片任务状态' })).toBeEnabled()
  } finally {
    await context.close(); await browser.close()
  }
})

test('recovers an image candidate failure without losing gate state', async () => {
  const detail = baseJob({
    outputs: [output()],
    images: ['https://assets.example.test/candidate-1.webp'],
  })
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix', { detail, imageFailureOnce: true })
  try {
    const candidate = page.getByRole('img', { name: /图片候选 1/ })
    await expect(candidate).toHaveCount(0)
    await expect(page.getByRole('alert')).toContainText('候选图片读取失败')
    const reload = page.getByRole('button', { name: '重新读取图片候选 1' })
    await expect(reload).toBeVisible()
    await reload.focus(); await page.keyboard.press('Enter')
    await expect(page.getByRole('img', { name: /图片候选 1/ })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('满足选择门禁', { exact: true })).toBeVisible()
  } finally {
    await context.close(); await browser.close()
  }
})

test('moves focus to the recoverable task-read error when the API is unavailable', async () => {
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix', { detail: null })
  try {
    const error = page.locator('#image-job-read-error')
    await expect(error).toBeVisible()
    await expect(error).toContainText('任务状态读取失败')
    await expect(error).toHaveAttribute('role', 'alert')
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('image-job-read-error')
    await expect(page.getByRole('button', { name: '刷新任务状态' })).toBeEnabled()
  } finally {
    await context.close(); await browser.close()
  }
})

test('submits the reasoned candidate choice and exposes the next review step', async () => {
  const detail = baseJob({ outputs: [output()], images: ['https://assets.example.test/candidate-1.webp'] })
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix', { detail })
  let selectionRequest
  page.on('request', request => {
    if (request.url().includes('/mcp') && request.postData()?.includes('content.visual.select')) selectionRequest = request
  })
  try {
    await expect(page.getByRole('img', { name: /图片候选 1/ })).toBeVisible({ timeout: 15_000 })
    const checkbox = page.getByRole('checkbox', { name: /选择为(?:主图|辅图)/ })
    await checkbox.check({ force: true })
    await expect(page.getByText('已选择 1 张候选')).toBeAttached()
    const submit = page.getByRole('button', { name: '提交选择（1/6）' })
    await expect(submit).toBeEnabled()
    await submit.focus(); await page.keyboard.press('Enter')
    await expect(page.locator('.image-selection-panel .info-notice[role="status"]')).toContainText('已提交 1 张候选')
    await expect(page.getByRole('button', { name: '进入新版本审核' })).toBeVisible()
    // The selection created a new review version. The original image job is
    // now a stale editing context, so it must not accept another mutation.
    await expect(checkbox).toBeDisabled()
    await expect(page.getByLabel('选图原因（必填）')).toBeDisabled()
    await expect(submit).toBeDisabled()
    expect(selectionRequest).toBeTruthy()
  } finally {
    await context.close(); await browser.close()
  }
})

test('switching deep-linked image jobs drops old candidates and ignores the late response', async () => {
  const jobA = baseJob({ job_id: 'job_image_a', product_id: 'product_a', outputs: [output({ visual_ref: 'visual_a', asset_id: 'asset_a' })], images: ['https://assets.example.test/candidate-1.webp'] })
  const jobB = baseJob({ job_id: 'job_image_b', product_id: 'product_b', outputs: [output({ visual_ref: 'visual_b', asset_id: 'asset_b' })], images: ['https://assets.example.test/candidate-1.webp'] })
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_a', {
    details: { job_image_a: jobA, job_image_b: jobB },
    detailDelayByJob: { job_image_a: [0, 900] },
  })
  const requestedJobs = []
  page.on('request', request => {
    const match = request.url().match(/\/v1\/image-generation-jobs\/([^/?]+)/)
    if (match) requestedJobs.push(match[1])
  })
  try {
    await expect(page.getByText(/任务 job_image_a · 商品 product_a/)).toBeVisible({ timeout: 15_000 })
    const checkbox = page.getByRole('checkbox', { name: /选择为(?:主图|辅图)/ })
    await checkbox.check({ force: true })
    await expect(page.getByText('已选择 1 张候选')).toBeAttached()
    const aReadCountBeforeRefresh = requestedJobs.filter(id => id === 'job_image_a').length
    await page.getByRole('button', { name: '刷新图片任务状态' }).click()
    await expect.poll(() => requestedJobs.filter(id => id === 'job_image_a').length).toBeGreaterThan(aReadCountBeforeRefresh)
    await page.waitForTimeout(50)
    await page.evaluate(() => {
      window.history.pushState(null, '', `${window.location.pathname}?image_job=job_image_b`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page.getByText(/任务 job_image_b · 商品 product_b/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('checkbox', { name: /选择为(?:主图|辅图)/ })).not.toBeChecked()
    await expect.poll(() => requestedJobs).toContain('job_image_b')
    await expect(page.getByText(/任务 job_image_a · 商品 product_a/)).toHaveCount(0)
    await page.waitForTimeout(1_000)
    await expect(page.getByText(/任务 job_image_b · 商品 product_b/)).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /选择为(?:主图|辅图)/ })).not.toBeChecked()
  } finally {
    await context.close(); await browser.close()
  }
})

test('returning from an image job keeps unrelated route context and clears only the image-job deep link', async () => {
  const detail = baseJob({ outputs: [output()], images: ['data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'] })
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix&workspace_hint=keep-me', { detail })
  try {
    await expect(page.getByText(/任务 job_image_matrix · 商品 product_1/)).toBeVisible()
    await page.locator('.task-breadcrumb').getByRole('button', { name: '营销任务' }).click()
    await expect(page).toHaveURL(/\/merchant\/tasks\?workspace_hint=keep-me$/u)
    await expect(page.locator('.image-generation-discovery')).toBeVisible()
    await expect(page.locator('.image-generation-job-panel')).toHaveCount(0)
  } finally {
    await context.close(); await browser.close()
  }
})
