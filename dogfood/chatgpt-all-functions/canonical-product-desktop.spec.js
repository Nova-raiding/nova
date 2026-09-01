import { expect, test, chromium } from '@playwright/test'

test.setTimeout(120_000)

const opsUrl = process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'

const session = (canRead = true) => ({
  actor_id: 'canonical-desktop-qa',
  workspace_id: 'ws_demo',
  roles: ['operator'],
  canonical_roles: ['operator'],
  workspace_granted: true,
  workbench: 'workspace',
  available_workbenches: ['workspace'],
  scope: { type: 'workspace', id: 'ws_demo' },
  capabilities: canRead
    ? ['workspace.summary.read', 'workspace.directory.read', 'platform.settings.read', 'store.connection.read', 'customer.content.read']
    : ['workspace.summary.read', 'workspace.directory.read', 'platform.settings.read', 'store.connection.read'],
})

const finding = (status, overrides = {}) => ({
  legacyProductId: `legacy-${status}`,
  productId: `product-${status}`,
  canonicalProductId: status === 'verified' ? `canonical-${status}` : undefined,
  status,
  codes: status === 'verified' ? [] : [`CANONICAL_${status.toUpperCase()}`],
  listingIds: status === 'verified' ? [`listing-${status}`] : [],
  campaignItemIds: status === 'verified' ? ['campaign-1'] : [],
  taskIds: status === 'verified' ? ['task-1'] : [],
  publishJobIds: [],
  scope: { brandId: 'brand-demo', platform: 'taobao', accountId: 'store-demo', listingId: null },
  evidence: { codes: [], generatedAt: '2026-09-01T08:00:00.000Z', revision: 'rev-canonical-desktop' },
  blocking: status === 'verified' ? undefined : {
    code: `CANONICAL_${status.toUpperCase()}`,
    message: `状态 ${status} 需要人工处理`,
    impact: '不能继续发布',
    objectType: 'product',
    objectId: `product-${status}`,
    retryable: status === 'blocked',
  },
  ...overrides,
})

const reportFor = (state) => {
  if (state === 'empty') {
    return {
      workspaceId: 'ws_demo', status: 'clean', counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 0 },
      findings: [], orphanFindings: [], freshness: 'fresh', availability: 'available', contractStatus: 'clean',
      generatedAt: '2026-09-01T08:00:00.000Z', readMode: 'live', revision: 'rev-empty',
    }
  }
  if (state === 'error') {
    return {
      workspaceId: 'ws_demo', status: 'attention_required', counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 0 },
      findings: [], orphanFindings: [], freshness: 'unknown', availability: 'unavailable', contractStatus: 'unavailable',
      error: { code: 'CANONICAL_READ_UNAVAILABLE', message: '一致性服务暂时不可用' },
    }
  }
  const status = state === 'expired' ? 'blocked' : state
  const row = finding(status, state === 'expired' ? { codes: ['CANONICAL_REPORT_EXPIRED'] } : {})
  return {
    workspaceId: 'ws_demo', status: status === 'verified' ? 'clean' : 'attention_required',
    counts: { verified: status === 'verified' ? 1 : 0, legacy_only: status === 'legacy_only' ? 1 : 0, conflict: status === 'conflict' ? 1 : 0, blocked: status === 'blocked' ? 1 : 0 },
    findings: [row], orphanFindings: [],
    freshness: state === 'expired' ? 'expired' : 'fresh', availability: 'available', contractStatus: status === 'verified' ? 'clean' : 'attention_required',
    generatedAt: '2026-09-01T08:00:00.000Z', readMode: 'live', revision: `rev-${state}`,
  }
}

const genericResult = (method) => {
  if (method === 'workspace.commercial.get') return { settings: {}, platforms: [], subscription: {}, orders: [] }
  if (method === 'ops.audit.list') return []
  if (method === 'ops.members.list') return []
  if (method === 'ops.stores.list') return { items: [] }
  if (method === 'ops.brand-units.summary') return { items: [] }
  if (method === 'ops.tasks.summary') return { generationQueueCount: 0, publishQueueCount: 0 }
  if (method === 'ops.marketing.summary') return { generationByState: {} }
  if (method === 'workspace.health') return { status: 'ok' }
  if (method === 'workspace.metrics') return { jobs: {}, stores: [], productSummary: {}, riskSummary: {}, taskFunnel: {} }
  if (method === 'platform.model.status') return { state: 'ready', capabilities: {} }
  return []
}

async function openCanonical(state) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(({ canRead }) => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'canonical-desktop-qa')
    localStorage.setItem('ops_api_token', 'canonical-desktop-local-token')
    localStorage.setItem('ops_workbench', 'workspace')
    if (!canRead) localStorage.setItem('canonical-desktop-permission-state', 'denied')
  }, { canRead: state !== 'permission' })
  await context.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON?.() ?? {}
    const method = body.method
    const result = method === 'ops.session'
      ? session(state !== 'permission')
      : method === 'canonical.product.consistency'
        ? reportFor(state)
        : genericResult(method)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 'canonical-desktop', result }),
    })
  })
  const page = await context.newPage()
  await page.goto(`${opsUrl}ops/stores?workbench=workspace`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: '平台连接汇总' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('规范商品一致性', { exact: true })).toBeVisible({ timeout: 20_000 })
  return { browser, context, page }
}

test('verified state shows evidence and a non-blocking status', async () => {
  const { browser, context, page } = await openCanonical('verified')
  try {
    await expect(page.getByText('已验证', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('关系链已验证', { exact: true })).toBeVisible()
    await expect(page.getByText('检查 revision：rev-verified')).toBeVisible()
    await expect(page.getByText('存在未验证关系')).toHaveCount(0)
  } finally { await page.close(); await context.close(); await browser.close() }
})

for (const state of ['legacy_only', 'conflict', 'blocked']) {
  test(`${state} state is visible and remains blocked`, async () => {
    const { browser, context, page } = await openCanonical(state)
    try {
      await expect(page.getByText(state === 'legacy_only' ? '仅旧商品' : state === 'conflict' ? '存在冲突' : '已阻断', { exact: true }).first()).toBeVisible()
      await expect(page.getByText('存在未验证关系', { exact: true })).toBeVisible()
      await expect(page.getByRole('alert').first()).toBeVisible()
      const details = page.getByRole('button', { name: /查看 legacy-/ }).first()
      await expect(details).toBeVisible()
      await details.click()
      await expect(page.getByText('不能继续发布', { exact: false }).first()).toBeVisible()
    } finally { await page.close(); await context.close(); await browser.close() }
  })
}

test('expired state is presented as stale evidence, never as verified', async () => {
  const { browser, context, page } = await openCanonical('expired')
  try {
    await expect(page.getByText('报告已过期', { exact: true })).toBeVisible()
    await expect(page.getByText('当前结果不能作为发布依据', { exact: false })).toBeVisible()
    await expect(page.getByText('已阻断', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '重新检查' }).first()).toBeVisible()
  } finally { await page.close(); await context.close(); await browser.close() }
})

test('empty state distinguishes a verified empty report from a loading failure', async () => {
  const { browser, context, page } = await openCanonical('empty')
  try {
    await expect(page.getByText('当前没有关系问题', { exact: true })).toBeVisible()
    await expect(page.getByText('服务端返回了空的一致性结果', { exact: false })).toBeVisible()
    await expect(page.getByText('没有可验证的关系记录')).toHaveCount(0)
  } finally { await page.close(); await context.close(); await browser.close() }
})

test('error state exposes an alert and retry instead of an empty success', async () => {
  const { browser, context, page } = await openCanonical('error')
  try {
    await expect(page.getByRole('alert').filter({ hasText: '一致性报告读取失败' })).toBeVisible()
    await expect(page.getByText('一致性服务暂时不可用', { exact: true })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '一致性报告读取失败' }).getByRole('button', { name: '重试' })).toBeVisible()
    await expect(page.getByText('需处理', { exact: true }).first()).toBeVisible()
  } finally { await page.close(); await context.close(); await browser.close() }
})

test('permission state clearly explains that missing data is not an empty result', async () => {
  const { browser, context, page } = await openCanonical('permission')
  try {
    await expect(page.getByText('当前会话无权读取一致性证据', { exact: true })).toBeVisible()
    await expect(page.getByText('这不是空结果', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('没有可验证的关系记录')).toHaveCount(0)
    await expect(page.getByText('已验证', { exact: true })).toHaveCount(0)
  } finally { await page.close(); await context.close(); await browser.close() }
})
