/**
 * Cross-replica persistence smoke. It intentionally writes on replica A and
 * reads on replica B; a single-process memory test cannot prove this.
 *
 * REPLICA_A_URL=http://127.0.0.1:8787 \
 * REPLICA_B_URL=http://127.0.0.1:8788 \
 * REPLICA_ACCOUNT_ID=<pre-provisioned-taobao-account-id> \
 * npm run test:replica-consistency
 */

type Envelope<T> = { data: T | null; error: { code?: string; message?: string } | null }
type ItemsPage<T> = { items: T[]; total: number; limit: number; offset: number }

const aUrl = (process.env.REPLICA_A_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const bUrl = (process.env.REPLICA_B_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '')
const workspaceId = process.env.REPLICA_WORKSPACE_ID ?? 'ws_demo'
const token = process.env.REPLICA_API_TOKEN ?? 'pilot-local-token'
const accountId = process.env.REPLICA_ACCOUNT_ID?.trim() ?? 'fixture-store-ws_demo-taobao'

function fail(message: string): never { throw new Error(`[replica-consistency] ${message}`) }

function normalizeItems<T>(value: T[] | ItemsPage<T>): T[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value.items)) return value.items
  fail('products response is neither an array nor a paginated items response')
}

async function request<T>(base: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('x-workspace-id', workspaceId)
  headers.set('authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(`${base}${path}`, { ...init, headers })
  const envelope = await response.json() as Envelope<T>
  if (!response.ok || envelope.error || envelope.data === null) fail(`${base}${path} failed: ${envelope.error?.code ?? response.status} ${envelope.error?.message ?? ''}`)
  return envelope.data as T
}

async function main() {
  const accounts = await request<{ items: Array<{ platform?: string; accountId?: string; state?: string }> }>(aUrl, '/v1/platform-accounts')
  if (!accounts.items.some(item => item.platform === 'taobao' && item.accountId === accountId)) fail(`replica A has no provisioned Taobao account ${accountId} in workspace ${workspaceId}`)
  const remoteId = `REPLICA-${Date.now()}`
  const product = await request<{ id: string; workspaceId: string }>(aUrl, '/v1/products/import', {
    method: 'POST',
    body: JSON.stringify({ platform: 'taobao', account_id: accountId, remote_id: remoteId, title: 'Replica consistency smoke', sku_count: 1, stock: 7 }),
  })
  if (product.workspaceId !== workspaceId) fail('replica A returned the wrong workspace')
  const productsOnB = normalizeItems(await request<Array<{ id: string; workspaceId: string }> | ItemsPage<{ id: string; workspaceId: string }>>(bUrl, '/v1/products'))
  if (!productsOnB.some(item => item.id === product.id && item.workspaceId === workspaceId)) fail('replica B did not observe the product written by replica A')
  const task = await request<{ id: string; productId: string }>(aUrl, '/v1/tasks', { method: 'POST', body: JSON.stringify({ product_id: product.id, platform: 'taobao', account_id: accountId }) })
  const taskOnB = await request<{ id: string; productId: string }>(bUrl, `/v1/tasks/${encodeURIComponent(task.id)}`)
  if (taskOnB.id !== task.id || taskOnB.productId !== product.id) fail('replica B did not observe the task written by replica A')
  console.log(JSON.stringify({ status: 'PASS', workspaceId, productId: product.id, taskId: task.id, writer: aUrl, reader: bUrl }, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
