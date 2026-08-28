/**
 * Merchant Studio runtime smoke.
 *
 * Production mode is deliberately read-only. Use SMOKE_MODE=fixture against a
 * disposable fixture API to exercise the complete task workflow.
 *
 * Examples:
 *   SMOKE_API_URL=http://127.0.0.1:8787 \
 *   SMOKE_UI_URL=http://127.0.0.1:18081 \
 *   npx tsx tests/merchant-studio-smoke.ts
 *
 *   SMOKE_MODE=fixture SMOKE_API_URL=http://127.0.0.1:8790 \
 *   SMOKE_UI_URL=http://127.0.0.1:5174 \
 *   npx tsx tests/merchant-studio-smoke.ts
 */

type Platform = 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin'

type Envelope<T> = {
  data: T | null
  error: { code?: string; message?: string } | null
}

type McpEnvelope<T> = Envelope<{ result: T }>

const apiUrl = (process.env.SMOKE_API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const uiUrl = (process.env.SMOKE_UI_URL ?? 'http://127.0.0.1:18081').replace(/\/$/, '')
const workspaceId = process.env.SMOKE_WORKSPACE_ID ?? 'ws_demo'
const token = process.env.SMOKE_API_TOKEN ?? 'pilot-local-token'
const mode = process.env.SMOKE_MODE ?? 'production'
const requireFullFlow = process.env.SMOKE_REQUIRE_FULL_FLOW === 'true' || mode === 'fixture'
const platforms: Platform[] = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']

function fail(message: string): never {
  throw new Error(`[merchant-studio-smoke] ${message}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message)
}

async function fetchWithRateLimitRetry(url: string, init?: RequestInit) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, init)
    if (response.status !== 429 || attempt === 1) return response
    const retryAfter = Number(response.headers.get('retry-after') ?? '1')
    const waitSeconds = Number.isFinite(retryAfter) ? Math.min(60, Math.max(1, Math.ceil(retryAfter))) : 1
    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1_000))
  }
  throw new Error('rate-limit retry exhausted')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  headers.set('x-workspace-id', workspaceId)
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetchWithRateLimitRetry(`${apiUrl}${path}`, { ...init, headers })
  let envelope: Envelope<T>
  try {
    envelope = await response.json() as Envelope<T>
  } catch {
    fail(`${init.method ?? 'GET'} ${path} returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok || envelope.error) {
    const error = new Error(envelope.error?.message ?? `HTTP ${response.status}`) as Error & { code?: string; status?: number }
    error.code = envelope.error?.code
    error.status = response.status
    throw error
  }
  assert(envelope.data !== null, `${init.method ?? 'GET'} ${path} returned null data`)
  return envelope.data
}

async function mcp<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetchWithRateLimitRetry(`${apiUrl}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-workspace-id': workspaceId, authorization: token ? `Bearer ${token}` : '' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `merchant-studio-smoke-${method}`, method, params: { workspace_id: workspaceId, ...params } }),
  })
  const envelope = await response.json() as McpEnvelope<T>
  if (!response.ok || envelope.error) {
    const error = new Error(envelope.error?.message ?? `MCP ${method} HTTP ${response.status}`) as Error & { code?: string; status?: number }
    error.code = envelope.error?.code
    error.status = response.status
    throw error
  }
  assert(envelope.data?.result !== undefined, `MCP ${method} returned no result`)
  return envelope.data.result
}

function expectError(error: unknown, code: string, label: string) {
  const actual = error as { code?: string; status?: number }
  assert(actual.code === code, `${label}: expected ${code}, got ${actual.code ?? actual.status ?? 'unknown'}`)
}

async function checkUi() {
  const response = await fetch(uiUrl)
  assert(response.ok, `UI ${uiUrl} returned HTTP ${response.status}`)
  const html = await response.text()
  assert(html.includes('Merchant Studio'), 'UI shell does not contain Merchant Studio')
  const asset = html.match(/src="([^"]+\.(?:js|tsx))"/)?.[1]
  assert(asset, 'UI index does not reference a JavaScript entry/bundle')
  const assetResponse = await fetch(new URL(asset, `${uiUrl}/`))
  assert(assetResponse.ok, `UI JavaScript bundle returned HTTP ${assetResponse.status}`)
  return { asset }
}

async function main() {
  const ui = await checkUi()
  const health = await request<{ connectors: Record<Platform, string>; writesEnabled: boolean; persistence?: { ready: boolean } }>('/healthz')
  assert(health.persistence?.ready !== false, 'API persistence is not ready')
  if (mode === 'production') assert(health.writesEnabled === false || process.env.SMOKE_ALLOW_WRITES === 'true', 'production smoke refuses an API with writes enabled')

  let accounts = await request<{ items: Array<{ platform: Platform; accountId?: string; state: string; readEnabled: boolean; writeEnabled: boolean }> }>('/v1/platform-accounts')
  if (mode === 'fixture') {
    for (const platform of platforms) {
      const existing = accounts.items.find(item => item.platform === platform && item.accountId)
      if (!existing) await mcp('platform.connect', { platform, store_key: 'merchant-studio-smoke' })
    }
    accounts = await request('/v1/platform-accounts')
  }
  const targetAccounts = accounts.items.filter(item => platforms.includes(item.platform))
  assert(targetAccounts.length >= platforms.length, `expected at least ${platforms.length} platform account rows, got ${targetAccounts.length}`)
  assert(new Set(targetAccounts.map(item => item.platform)).size === platforms.length, 'platform account rows are not isolated by platform')
  for (const platform of platforms) assert(targetAccounts.some(item => item.platform === platform), `missing account row for ${platform}`)
  const accountByPlatform = new Map(targetAccounts.map(item => [item.platform, item]))

  if (mode === 'fixture') {
    const order = await mcp<{ id: string; amount_cny: string }>('billing.recharge.create', { channel: 'wechat', amount_cny: '10.00', idempotency_key: `merchant-studio-smoke-${workspaceId}` })
    await request(`/v1/billing/callback/wechat`, { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, order_id: order.id, provider_trade_id: `merchant-studio-smoke-trade-${workspaceId}`, amount_fen: Math.round(Number(order.amount_cny) * 100), state: 'SUCCESS' }) })
  }

  const productsBefore = await request<Array<{ id: string; platform: Platform; workspaceId: string; title: string }>>('/v1/products')
  for (const product of productsBefore) assert(product.workspaceId === workspaceId, `product ${product.id} crossed workspace boundary`)

  const syncResults = await Promise.all(platforms.map(async platform => {
    try {
      const result = await request<{ platform: Platform; items: unknown[]; simulated: boolean }>(`/v1/platform-accounts/${platform}/sync`, { method: 'POST', body: JSON.stringify({}) })
      assert(result.platform === platform, `sync response platform mismatch for ${platform}`)
      return { platform, result }
    } catch (error) {
      if (!accountByPlatform.get(platform)?.readEnabled) {
        expectError(error, 'NOT_CONFIGURED', `unconfigured ${platform} sync`)
        return { platform, blocked: true }
      }
      throw error
    }
  }))
  assert(syncResults.length === platforms.length, 'not all platform sync probes completed')

  const products = await request<Array<{ id: string; platform: Platform; title: string }>>('/v1/products')
  if (mode === 'production') {
    console.log(JSON.stringify({ status: 'PASS', mode, ui, platforms, productCount: products.length, fullFlow: 'SKIPPED_READ_ONLY_PRODUCTION', note: 'Production smoke is read-only; use disposable fixture mode for workflow writes.' }, null, 2))
    return
  }
  if (!products.length) {
    assert(!requireFullFlow, 'full flow requested but fixture API returned no products')
    console.log(JSON.stringify({ status: 'PASS', mode, ui, platforms, fullFlow: 'SKIPPED_NO_PRODUCTS', note: 'Production API is correctly fail-closed until platform accounts are configured.' }, null, 2))
    return
  }
  assert(requireFullFlow || mode === 'fixture', 'full workflow is only allowed against explicit fixture mode')

  const product = products[0] as { id: string; platform: Platform; title: string; skus?: Array<{ id: string }> }
  assert(product, 'fixture product missing')
  const confirmedProduct = await request<{ id: string; factsConfirmed?: boolean }>(`/v1/products/${encodeURIComponent(product.id)}/confirm`, { method: 'POST', body: JSON.stringify({}) })
  assert(confirmedProduct.id === product.id && confirmedProduct.factsConfirmed === true, 'product facts were not confirmed before task creation')
  const task = await request<{ id: string; productId: string; platform: Platform }>(`/v1/tasks`, { method: 'POST', body: JSON.stringify({ product_id: product.id, platform: product.platform, answers: { ...(product.skus?.[0]?.id ? { sku_id: product.skus[0].id } : {}), placement: '商品详情页', goal: '准确表达商品事实' } }) })
  assert(task.productId === product.id && task.platform === product.platform, 'created task is not bound to selected product/platform')
  const selected = await request<{ id: string; selectedDirectionId?: string }>(`/v1/tasks/${encodeURIComponent(task.id)}/directions`, { method: 'POST', body: JSON.stringify({ direction_id: 'A' }) })
  assert(selected.selectedDirectionId === 'A', 'direction selection was not persisted')
  const plan = await request<{ id: string; state: string; productionPlan?: unknown }>(`/v1/tasks/${encodeURIComponent(task.id)}/plan/confirm`, { method: 'POST', body: JSON.stringify({ actor_id: 'merchant' }) })
  assert(plan.id === task.id && plan.state === 'plan_confirmed' && plan.productionPlan, 'production plan was not confirmed before content generation')
  const draft = await request<{ id: string; taskId: string; version: number; body: { title: string; detail: string } }>(`/v1/tasks/${encodeURIComponent(task.id)}/content`, { method: 'POST' })
  assert(draft.taskId === task.id && draft.version > 0 && draft.body.title.length > 0, 'content generation did not return a usable version')
  const approved = await request<{ task: { state: string }; version: { id: string; state: string } }>(`/v1/tasks/${encodeURIComponent(task.id)}/approve`, { method: 'POST', body: JSON.stringify({ content_version_id: draft.id }) })
  assert(approved.version.state === 'approved', 'content approval did not lock the version')
  const preview = await request<{ task: { id: string }; version: { id: string }; confirmationHash: string; remoteSnapshotHash: string; changes: string[] }>(`/v1/tasks/${encodeURIComponent(task.id)}/publish-preview`, { method: 'POST' })
  assert(preview.task.id === task.id && preview.version.id === draft.id, 'publish preview is not bound to approved task/version')
  assert(preview.confirmationHash.length > 10 && preview.remoteSnapshotHash.length > 10, 'publish preview lacks confirmation or remote snapshot hash')
  const job = await request<{ id: string; taskId: string; state: string }>(`/v1/publish-jobs`, { method: 'POST', headers: { 'idempotency-key': `smoke-${task.id}-${draft.id}` }, body: JSON.stringify({ task_id: task.id, content_version_id: draft.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash }) })
  assert(job.taskId === task.id && ['queued', 'submitted', 'reviewing', 'published'].includes(job.state), `publish confirmation returned unexpected state ${job.state}`)

  console.log(JSON.stringify({ status: 'PASS', mode, ui, platforms, sync: syncResults.map(item => item.platform), fullFlow: { productId: product.id, taskId: task.id, contentVersionId: draft.id, publishJobId: job.id, publishState: job.state } }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
