import { expect } from '@playwright/test'
import { commercialRpcRequestSignature } from './commercial-rpc-observation.js'

// Helpers for the owned real PG/password-session commercial sales runner.
// No service startup, route interception, token fixture or financial seeding.
const required = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`ISOLATED_COMMERCIAL_RUNNER_REQUIRES_${name}`)
  return value
}
const money = fen => `¥${(fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const date = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
const center = page => page.getByRole('region', { name: '套餐与权益包', exact: true })
const dialog = page => page.getByRole('dialog', { name: '确认服务端订单与付款明细', exact: true })
const payload = request => {
  try { return request.postDataJSON() } catch { return null }
}
async function rpcResult(response) {
  expect(response.status()).toBe(200)
  const envelope = await response.json()
  const body = envelope.data ?? envelope
  expect(body.error, JSON.stringify(body.error)).toBeFalsy()
  expect(body).toHaveProperty('result')
  return body.result
}
// Capture the response belonging to a UI action, excluding earlier background
// refreshes of the same method. Never emit request headers or auth bodies.
export async function merchantRpcAction(page, method, action) {
  const issued = new Set()
  const observed = new Set()
  const listener = request => {
    const observedMethod = payload(request)?.method
    const signature = commercialRpcRequestSignature(request)
    if (typeof observedMethod === 'string') observed.add(`${new URL(request.url()).pathname}:${observedMethod}`)
    if (observedMethod === method) issued.add(signature)
  }
  page.on('request', listener)
  try {
    // Playwright can materialize distinct Request wrappers for the page's
    // `request` and `response` events. Correlate by the exact request bytes
    // rather than wrapper identity, so a successful MCP response is not
    // reported as a network failure by the owned desktop regression.
    const waiting = page.waitForResponse(response => issued.has(commercialRpcRequestSignature(response.request())), { timeout: 10000 }).catch(error => {
      throw new Error(`COMMERCIAL_UI_RPC_NOT_OBSERVED:${method}; seen=${[...observed].join(',') || 'none'}; page=${page.url()}; ${error.message}`)
    })
    await action()
    return await rpcResult(await waiting)
  } finally { page.off('request', listener) }
}

export async function loginCommercialMerchant(browser, overrides = {}) {
  if (overrides.username !== undefined && overrides.loginIdentifier !== undefined && overrides.username !== overrides.loginIdentifier) throw new Error('COMMERCIAL_SALES_CONFLICTING_MERCHANT_IDENTIFIERS')
  const username = overrides.username ?? overrides.loginIdentifier ?? required('OPS_E2E_MERCHANT_USERNAME')
  const password = overrides.password ?? required('OPS_E2E_MERCHANT_PASSWORD')
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password.trim()) throw new Error('COMMERCIAL_SALES_REQUIRES_EXPLICIT_MERCHANT_CREDENTIALS')
  const url = new URL(overrides.baseUrl ?? required('MERCHANT_STUDIO_URL'))
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password) throw new Error('COMMERCIAL_SALES_REQUIRES_OWNED_LOOPBACK_RUNTIME')
  required('OPS_E2E_OUTPUT_DIR')
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
  const studio = await context.newPage()
  try {
    await studio.goto(new URL('/merchant/login', url).href)
    await studio.getByPlaceholder('例如 merchant@example.com').fill(username)
    await studio.getByPlaceholder('请输入商家密码').fill(password)
    const response = studio.waitForResponse(item => new URL(item.url()).pathname === '/api/v1/auth/login' && item.request().method() === 'POST')
    await studio.getByRole('button', { name: '登录商家工作台', exact: true }).click()
    expect((await response).status()).toBe(200)
    await expect(studio.getByRole('button', { name: '登录商家工作台', exact: true })).toBeHidden({ timeout: 30000 })
    await studio.goto(new URL('/merchant/finance', url).href)
    await expect(center(studio)).toBeVisible()
    return studio
  } catch (error) { await context.close(); throw error }
}

export async function readCurrentContract(studio) {
  await studio.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  const refresh = center(studio).getByRole('button', { name: /刷新已购与商品/u })
  // The finance center defaults to the product catalog tab. Subscription
  // refresh is intentionally available only after selecting a purchased-state
  // tab, so make that UI state explicit before observing the real RPC.
  await center(studio).getByRole('tab', { name: /当前套餐/u }).click()
  await expect(refresh).toBeEnabled()
  const result = await merchantRpcAction(studio, 'commercial.subscription.get', () => refresh.evaluate(button => button.click()))
  expect(result).toMatchObject({ schema_version: 'commercial.subscription.v1', status: 'available' })
  expect(typeof result.onboarding_qualified).toBe('boolean')
  for (const field of ['future', 'packs', 'history', 'orders']) expect(Array.isArray(result[field]), field).toBe(true)
  expect(result).toHaveProperty('current')
  return result
}

export async function assertSaleNotice(studio, { code, name }, batch) {
  const notices = studio.getByRole('region', { name: '套餐与权益包通知', exact: true })
  await expect(notices).toBeVisible()
  const item = batch.items.find(row => row.sku_code === code)
  expect(item, `published notification for ${code}`).toBeTruthy()
  const row = notices.locator('li').filter({ hasText: item.title }).filter({ hasText: `发布版本 v${item.version}` })
  await expect(row.first()).toContainText(name ?? item.title)
  await row.first().getByRole('button', { name: '查看当前商品与价格', exact: true }).click()
  await expect(center(studio)).toContainText('通知对应的当前商品')
  return item
}

export async function assertCurrentPlan(studio, { name, code, periodEnd, priceFen }) {
  const portfolio = await readCurrentContract(studio)
  expect(portfolio.current).toBeTruthy()
  if (code) expect(portfolio.current.skuCode).toBe(code)
  if (periodEnd) expect(portfolio.current.periodEnd).toBe(periodEnd)
  await center(studio).getByRole('tab', { name: '当前套餐', exact: true }).click()
  const table = studio.locator('[aria-label="当前生效套餐"]')
  await expect(table).toContainText(code ?? name)
  if (periodEnd) await expect(table).toContainText(date(periodEnd))
  // Contract table exposes frozen rights and dates; it has no price column.
  // price assertion must use an actual frozen order, never a catalog price.
  if (priceFen !== undefined) {
    const source = portfolio.orders.find(order => (order.id ?? order.order_id) === portfolio.current.sourceOrderId)
    expect(source, 'current source order must be available for a frozen price assertion').toBeTruthy()
    expect(Number(source.amount_fen ?? source.amountFen)).toBe(priceFen)
  }
  return portfolio.current
}

export async function assertFuturePlans(studio, { expectedCount, codes = [] }) {
  const portfolio = await readCurrentContract(studio)
  expect(portfolio.future).toHaveLength(expectedCount)
  await center(studio).getByRole('tab', { name: `未来待生效（${expectedCount}）`, exact: true }).click()
  await expect(center(studio)).toContainText('当前不可消费或预留')
  const table = studio.locator('[aria-label="未来待生效套餐"]')
  for (const code of codes) await expect(table).toContainText(code)
  if (expectedCount) await expect(table).toContainText('未来待生效')
  return portfolio.future
}

export async function assertMerchantPointPack(studio, { code, name }) {
  const portfolio = await readCurrentContract(studio)
  expect(portfolio.packs.some(pack => pack.skuCode === code)).toBe(true)
  await center(studio).getByRole('tab', { name: `独立权益包（${portfolio.packs.length}）`, exact: true }).click()
  await expect(center(studio).getByRole('tabpanel').filter({ hasText: code })).toContainText(code)
  // Portfolio renders immutable code/version, not mutable catalog display name.
  return portfolio.packs.filter(pack => pack.skuCode === code)
}

export async function openMerchantProduct(studio, { code, action = '购买套餐' }) {
  const row = center(studio).locator('tr').filter({ hasText: code }).filter({ has: studio.getByRole('button', { name: action, exact: true }) })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: action, exact: true }).evaluate(button => button.click())
  await expect(dialog(studio)).toBeVisible()
  return dialog(studio)
}

export async function prepareMerchantPurchase(studio, { code, firstPurchase = false, action = '购买套餐' }) {
  const checkout = await openMerchantProduct(studio, { code, action })
  const result = await merchantRpcAction(studio, firstPurchase ? 'commercial.checkout.create' : 'commercial.order.create', () => checkout.getByRole('button', { name: '生成订单明细，暂不付款', exact: true }).click())
  const orders = firstPurchase ? result.orders : [result]
  expect(orders).toHaveLength(firstPurchase ? 2 : 1)
  await expect(checkout).toContainText('开通与套餐分别计费')
  for (const order of orders) {
    await expect(checkout).toContainText(order.sku_version_id)
    await expect(checkout).toContainText(money(order.amount_fen))
    expect(order.snapshot.quantity).toBe(1)
    expect(Array.isArray(order.snapshot.benefits)).toBe(true)
  }
  await expect(checkout.getByRole('button', { name: /^确认待付款分项 /u })).toBeDisabled()
  return { checkout, orders, result }
}

// Exercise an actual committed first-checkout request whose response is lost
// at the browser boundary. The server response is observed before aborting the
// client connection, then the merchant recovers the same two frozen lines via
// the UI's original-request lookup.
export async function prepareMerchantFirstCheckoutWithRecovery(studio, { code }) {
  const checkout = await openMerchantProduct(studio, { code })
  let committed
  let writeCount = 0
  const dropResponse = async route => {
    const request = route.request()
    if (payload(request)?.method !== 'commercial.checkout.create') return route.continue()
    writeCount += 1
    const response = await route.fetch()
    committed = await rpcResult(response)
    await route.abort('failed')
  }
  await studio.route('**/api/mcp', dropResponse)
  try {
    await checkout.getByRole('button', { name: '生成订单明细，暂不付款', exact: true }).click()
    await expect.poll(() => writeCount).toBe(1)
    await expect.poll(() => committed?.orders?.length).toBe(2)
    await expect(checkout.getByRole('button', { name: '查询原提交结果', exact: true })).toBeEnabled()
  } finally {
    await studio.unroute('**/api/mcp', dropResponse)
  }
  const recovered = await merchantRpcAction(studio, 'commercial.checkout.request.get', () =>
    checkout.getByRole('button', { name: '查询原提交结果', exact: true }).click(),
  )
  expect(recovered.checkout_id).toBe(committed.checkout_id)
  expect(recovered.orders.map(order => order.order_id)).toEqual(committed.orders.map(order => order.order_id))
  expect(recovered.orders).toHaveLength(2)
  for (const order of recovered.orders) await expect(checkout).toContainText(order.sku_version_id)
  return { checkout, orders: recovered.orders, result: recovered, original: committed, writeCount }
}

export async function prepareMerchantUpgrade(studio, { code }) {
  const before = await readCurrentContract(studio)
  expect(before.current).toBeTruthy()
  const checkout = await openMerchantProduct(studio, { code, action: '计算升级差价' })
  const quote = await merchantRpcAction(studio, 'commercial.upgrade.quote.create', () => checkout.getByRole('button', { name: '计算剩余期差价', exact: true }).click())
  expect(quote.period_end).toBe(before.current.periodEnd)
  expect(quote.target_sku_code).toBe(code)
  expect(quote.amount_fen).toBeGreaterThan(0)
  await expect(checkout).toContainText(money(quote.amount_fen))
  await expect(checkout).toContainText('未来订单仍按原档位')
  const order = await merchantRpcAction(studio, 'commercial.order.create', () => checkout.getByRole('button', { name: `生成补差价 ${money(quote.amount_fen)} 的订单明细`, exact: true }).click())
  expect(order.amount_fen).toBe(quote.amount_fen)
  await expect(checkout).toContainText(order.sku_version_id)
  return { before, quote, order, checkout }
}

export async function confirmMerchantFrozenPayment(studio, orders) {
  const checkout = dialog(studio)
  const total = orders.reduce((sum, order) => sum + order.amount_fen, 0)
  await expect(checkout.getByRole('checkbox')).toHaveCount(1)
  await checkout.getByRole('checkbox').check()
  await checkout.getByRole('button', { name: `确认待付款分项 ${money(total)}`, exact: true }).click()
  // Only approved manual instructions are asserted. No actual transfer is
  // manufactured here, and clicking confirmation cannot prove paid/granted.
  await expect(checkout).toContainText('已批准人工转账：')
  await expect(checkout).toContainText('备注/订单引用：')
}

export async function closeMerchantCheckout(studio) {
  await dialog(studio).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog(studio)).toBeHidden()
}

export async function submitMerchantSupport(studio, { subject, message }) {
  await center(studio).getByRole('button', { name: /^(首单前需要人工支持|提交人工支持)$/u }).first().click()
  const support = studio.getByRole('region', { name: '首单前人工支持', exact: true })
  await support.getByLabel('问题标题', { exact: true }).fill(subject)
  await support.getByLabel('问题说明', { exact: true }).fill(message)
  const waiting = studio.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/support/requests' && response.request().method() === 'POST')
  await support.getByRole('button', { name: '提交人工支持', exact: true }).click()
  const response = await waiting
  expect(response.status()).toBe(201)
  const envelope = await response.json()
  const receipt = envelope.data ?? envelope
  expect(receipt).toMatchObject({ submitted: true, status: 'open' })
  await expect(support).toContainText(receipt.ticket_number)
  return receipt
}

export async function assertMerchantSupportReply(studio, { customerReply, internalReply }) {
  const support = studio.getByRole('region', { name: '首单前人工支持', exact: true })
  await support.getByRole('button', { name: '查询本人客户可见回复', exact: true }).click()
  await expect(support).toContainText(customerReply)
  if (internalReply) await expect(support).not.toContainText(internalReply)
}

export async function readMerchantPointStatement(studio) {
  // Navigation causes the real finance screen to read its real ledger. No
  // auth token is extracted into the runner and no synthetic grant is made.
  const statement = await merchantRpcAction(studio, 'creative-points.statement.list', () => studio.reload({ waitUntil: 'domcontentloaded' }))
  expect(statement.schema_version).toBe('creative-points.statement.v1')
  expect(Array.isArray(statement.entries)).toBe(true)
  expect(statement.next_cursor, 'gift assertion requires a complete statement, not a partial first page').toBeNull()
  return statement.entries
}

export async function assertMerchantGrantLedger(studio, { sourceType, sourceIds, pointsPerGrant, expectedCount }) {
  const entries = await readMerchantPointStatement(studio)
  const grants = entries.filter(entry => entry.grantSourceType === sourceType && sourceIds.includes(entry.grantSourceId) && Number(entry.pointsDelta) > 0)
  expect(grants).toHaveLength(expectedCount)
  for (const grant of grants) expect(Number(grant.pointsDelta)).toBe(pointsPerGrant)
  // This proves issued ledger entries only. Future grant schedules/expiry and
  // dispatch replay require the worker+PG assertions in the owning runner.
  return grants
}
