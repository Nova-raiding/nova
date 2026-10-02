import { request } from 'playwright'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Production acceptance: login/session -> scoped MCP credential -> approved
// catalog -> optional unpaid checkout -> real provider-confirmed payment.
// Never confirms test payments, calls callbacks or follows checkout URLs.
const base = process.env.RECHARGE_QA_BASE_URL || 'https://yxsona.com'
const parsed = new URL(base)
if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('HTTPS_ORIGIN_REQUIRED')
const output = resolve(process.env.RECHARGE_QA_OUTPUT || 'artifacts/production-recharge-qa/e2e')
const evidence = { observed_at: new Date().toISOString(), origin: parsed.origin, scope: 'real-production-commercial-payment', stages: [], status: 'incomplete' }
await mkdir(output, { recursive: true, mode: 0o700 })
const client = await request.newContext({ baseURL: parsed.origin, timeout: 20000 })
const fail = code => { throw new Error(code) }
let token
let refreshToken
const rpc = async (method, params = {}) => {
  const response = await client.post('/api/mcp', {
    headers: { authorization: `Bearer ${token}`, 'x-workspace-id': process.env.RECHARGE_QA_WORKSPACE },
    data: { jsonrpc: '2.0', id: `recharge-${Date.now()}`, method, params },
  })
  const body = await response.json()
  evidence.stages.push({ method, http_status: response.status(), request_id: body.request_id, error_code: body.error?.code })
  if (!response.ok() || body.error) fail(body.error?.code || `HTTP_${response.status()}`)
  if (!body.data || !Object.hasOwn(body.data, 'result')) fail('MCP_RESULT_MISSING')
  return body.data.result
}
const orderSummary = order => ({ order_id: order.order_id, sku_code: order.sku_code, status: order.status, amount_fen: order.amount_fen, currency: order.currency, payment_provider: order.payment_provider, paid_at: order.paid_at, access_revision: order.access_revision, checkout_uri_present: Boolean(order.payment_url), checkout_replayed: order.checkout_replayed })
try {
  const health = await client.get('/api/healthz')
  const value = await health.json()
  evidence.health = { http_status: health.status(), writesEnabled: value.data?.writesEnabled, payment: value.data?.setup?.payment }
  const release = await client.get('/api/releasez')
  evidence.release = (await release.json()).data?.release
  if (!process.env.RECHARGE_QA_CREDENTIALS_FILE || !process.env.RECHARGE_QA_WORKSPACE) fail('MERCHANT_CREDENTIALS_AND_WORKSPACE_REQUIRED')
  const credentials = JSON.parse(await readFile(process.env.RECHARGE_QA_CREDENTIALS_FILE, 'utf8'))
  if (!credentials.login || !credentials.password) fail('LOGIN_PASSWORD_REQUIRED')
  const login = await client.post('/api/v1/auth/login', { data: { login: credentials.login, password: credentials.password, account_type: 'merchant' } })
  const logged = await login.json()
  evidence.stages.push({ stage: 'merchant-login', http_status: login.status(), error_code: logged.error?.code })
  if (!login.ok() || logged.error) fail(logged.error?.code || 'LOGIN_FAILED')
  const session = await client.get('/api/v1/auth/session')
  const sessionData = await session.json()
  if (!session.ok() || !sessionData.data?.workspaces?.includes(process.env.RECHARGE_QA_WORKSPACE)) fail('SESSION_WORKSPACE_NOT_AUTHORIZED')
  const exchange = await client.post('/api/v1/auth/mcp-token', { data: { workspace_id: process.env.RECHARGE_QA_WORKSPACE } })
  const issued = await exchange.json()
  token = issued.data?.access_token
  refreshToken = issued.data?.refresh_token
  if (!exchange.ok() || typeof token !== 'string' || !token) fail(issued.error?.code || 'MCP_CREDENTIAL_ISSUE_FAILED')
  const before = await rpc('creative-points.balance.get')
  evidence.balance_before = before
  const catalog = await rpc('commercial.catalog.get')
  evidence.catalog = catalog
  let orderId = process.env.RECHARGE_QA_ORDER_ID
  if (!orderId && process.env.RECHARGE_QA_CREATE_ORDER === 'true') {
    if (!process.env.RECHARGE_QA_SKU || !process.env.RECHARGE_QA_IDEMPOTENCY_KEY) fail('SKU_AND_STABLE_IDEMPOTENCY_KEY_REQUIRED')
    const intent = { purchase_kind: process.env.RECHARGE_QA_KIND || 'point_pack', sku_code: process.env.RECHARGE_QA_SKU, reason: '商家授权的生产充值端到端验收，支付由用户本人完成', idempotency_key: process.env.RECHARGE_QA_IDEMPOTENCY_KEY }
    const order = await rpc('commercial.order.create', intent)
    evidence.created_order = orderSummary(order)
    orderId = order.order_id
    if (!orderId) fail('ORDER_ID_MISSING')
    const replay = await rpc('commercial.order.create', intent)
    if (replay.order_id !== orderId || replay.amount_fen !== order.amount_fen) fail('ORDER_REPLAY_MISMATCH')
    evidence.idempotent_replay = orderSummary(replay)
  }
  if (!orderId) fail('EXISTING_ORDER_OR_EXPLICIT_CREATE_INTENT_REQUIRED')
  const order = await rpc('commercial.order.payment.get', { order_id: orderId })
  evidence.payment_status = orderSummary(order)
  evidence.balance_after = await rpc('creative-points.balance.get')
  const statement = await rpc('creative-points.statement.list', { limit: '100' })
  evidence.statement = statement
  if (order.status !== 'paid' || !order.paid_at) fail('REAL_USER_PAYMENT_NOT_YET_CONFIRMED')
  // Reading a paid flag alone cannot establish ledger correlation. Save both
  // facts for owner DB/audit reconciliation; don't manufacture ledger proof.
  evidence.status = 'paid_observed_ledger_reconciliation_required'
} catch (error) {
  evidence.blocker = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'REQUEST_OR_RUNTIME_FAILED'
  process.exitCode = 2
} finally {
  if (refreshToken) {
    try { await client.post('/api/v1/auth/mcp-token/revoke', { data: { refresh_token: refreshToken } }) } catch { evidence.cleanup_error = 'TOKEN_REVOCATION_FAILED' }
  }
  try { await client.post('/api/v1/auth/logout', { data: {} }) } catch { evidence.cleanup_error = 'SESSION_LOGOUT_FAILED' }
  await client.dispose()
  await writeFile(resolve(output, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ status: evidence.status, blocker: evidence.blocker, evidence: resolve(output, 'result.json') }))
}
