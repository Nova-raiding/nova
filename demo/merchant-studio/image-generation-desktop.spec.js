import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081'
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

async function installApiRoutes(page, { jobs = [], detail, retryJob, imageFailureOnce = false, detailDelayMs = 0 } = {}) {
  await page.route('**/healthz', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ status: 'ok', writesEnabled: true, connectors: {}, persistence: { mode: 'postgres', ready: true } })),
  }))
  await page.route('**/mcp', async route => {
    const body = route.request().postDataJSON?.() ?? {}
    const result = body.method === 'platform.model.status'
      ? { state: 'ready', capabilities: { image_generation: true, image_editing: true }, next_actions: [] }
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
  await page.route('**/v1/image-generation-jobs/*', async route => {
    if (detailDelayMs) await new Promise(resolve => setTimeout(resolve, detailDelayMs))
    if (!detail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null)) })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(detail)) })
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
  await page.route('**/v1/workspaces/*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [] })) }))
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
    await expect(page.getByText('图片生成任务')).toBeVisible()
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
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix', { detail })
  try {
    await expect(page.getByRole('alert')).toContainText('IMAGE_GENERATION_PRE_PROVIDER_FAILED')
    const retry = page.getByRole('button', { name: '安全重试' })
    await expect(retry).toBeVisible()
    let retryRequest
    page.on('request', request => {
      if (request.url().includes('/mcp') && request.postData()?.includes('catalog.image.retry')) retryRequest = request
    })
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => Boolean(retryRequest)).toBe(true)
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
    await expect(page.getByRole('img', { name: /图片候选 1/ })).toBeVisible()
    await expect(page.getByText('满足选择门禁', { exact: true })).toBeVisible()
  } finally {
    await context.close(); await browser.close()
  }
})

test('supports keyboard candidate selection and submits the reasoned choice', async () => {
  const detail = baseJob({ outputs: [output()], images: ['https://assets.example.test/candidate-1.webp'] })
  const { browser, context, page } = await openPage('/merchant/tasks?image_job=job_image_matrix', { detail })
  let selectionRequest
  page.on('request', request => {
    if (request.url().includes('/mcp') && request.postData()?.includes('content.visual.select')) selectionRequest = request
  })
  try {
    const checkbox = page.getByRole('checkbox', { name: /选择为(?:主图|辅图)/ })
    await checkbox.focus(); await page.keyboard.press('Space')
    await expect(page.getByText('已选择 1 张候选')).toBeAttached()
    const submit = page.getByRole('button', { name: '提交选择（1/6）' })
    await expect(submit).toBeEnabled()
    await submit.focus(); await page.keyboard.press('Enter')
    await expect(page.locator('.image-selection-panel .info-notice[role="status"]')).toContainText('已提交 1 张候选')
    expect(selectionRequest).toBeTruthy()
  } finally {
    await context.close(); await browser.close()
  }
})
