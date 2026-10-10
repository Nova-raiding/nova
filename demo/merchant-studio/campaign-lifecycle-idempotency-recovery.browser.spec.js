import { expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_campaign_lifecycle_recovery_fixture'
const campaignId = 'campaign-lifecycle-recovery-fixture'
const envelope = (data, error = null) => ({ request_id: 'campaign-lifecycle-recovery', trace_id: 'campaign-lifecycle-recovery', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const campaign = (state = 'running', revision = 7) => ({ id: campaignId, state, revision, items: [{ id: 'item-1', state: 'running', product_id: 'product-1', platform: 'jd', account_id: 'store-1' }] })

test.setTimeout(120_000)

let vite
let browser
let studioUrl

test.beforeAll(async () => {
  vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Campaign lifecycle fixture did not bind a loopback port')
  studioUrl = `http://127.0.0.1:${address.port}`
  browser = await (await import('playwright')).chromium.launch({ channel: 'chrome', headless: true })
}, 60_000)

test.afterAll(async () => {
  try { await browser?.close() }
  finally { await vite?.close() }
}, 60_000)

test('unknown campaign action response can recover by replaying the exact idempotent request', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const requests = []
  let accepted = null
  await page.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON()
    if (body.method === 'campaign.batch.list') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { items: [{ id: campaignId, state: 'running', revision: 7, platform: 'jd', accountId: 'store-1', itemCount: 1, failedCount: 0, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' }] } })) })
    if (body.method === 'campaign.batch.get') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: campaign() })) })
    if (body.method === 'campaign.batch.pause') {
      requests.push(body.params)
      if (!accepted) {
        accepted = campaign('paused', 8)
        accepted.idempotencyKey = body.params.idempotency_key
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'API_REQUEST_TIMEOUT', message: 'fixture simulates a committed response lost in transit' })) })
      }
      if (body.params.idempotency_key !== accepted.idempotencyKey) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'CAMPAIGN_REVISION_CONFLICT', message: 'campaign revision changed' })) })
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: accepted })) })
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_UNEXPECTED_METHOD', message: `Unexpected method ${body.method}` })) })
  })

  try {
    await page.goto(`${studioUrl}/campaign-lifecycle-browser-harness.html`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '打开高级控制' }).click()
    await expect(page.getByRole('option', { name: /处理中/u })).toHaveCount(1)
    await page.getByRole('button', { name: '读取所选计划' }).click()
    await expect(page.getByText(/当前状态版本已读取/u)).toBeVisible()
    await page.getByRole('button', { name: '暂停' }).click()
    const dialog = page.getByRole('dialog', { name: '确认暂停批量任务' })
    await dialog.getByLabel('操作原因').fill('核对后暂停')
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: '确认并提交' }).click()
    await expect(dialog.getByRole('alert')).toContainText('API 请求超时')
    await expect(dialog.getByRole('status')).toContainText('提交结果尚未确认')
    await expect(dialog.getByLabel('操作原因')).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '取消' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '按原参数重试' }).click()
    await expect(dialog).toBeHidden()
    expect(requests).toHaveLength(2)
    expect(requests[0].idempotency_key).toMatch(/^merchant:pause:/u)
    expect(requests[1].idempotency_key).toBe(requests[0].idempotency_key)
    expect(requests[1]).toMatchObject({ campaign_id: campaignId, expected_revision: '7', reason: '核对后暂停' })
  } finally {
    await context.close()
  }
})

test('retry failed items keeps selected failures and reuses the same request after an unknown result', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const requests = []
  let accepted = null
  const failedSnapshot = {
    id: campaignId,
    state: 'failed',
    revision: 9,
    items: [
      { id: 'item-failed-1', state: 'failed', product_id: 'product-1', platform: 'jd', account_id: 'store-1' },
      { id: 'item-succeeded-2', state: 'succeeded', product_id: 'product-2', platform: 'jd', account_id: 'store-1' },
    ],
  }
  await page.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON()
    if (body.method === 'campaign.batch.list') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { items: [{ id: campaignId, state: 'failed', revision: 9, platform: 'jd', accountId: 'store-1', itemCount: 2, failedCount: 1, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' }] } })) })
    if (body.method === 'campaign.batch.get') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: failedSnapshot })) })
    if (body.method === 'campaign.batch.retry_failed') {
      requests.push(body.params)
      if (!accepted) {
        accepted = { ...failedSnapshot, state: 'running', revision: 10, items: [{ ...failedSnapshot.items[0], state: 'queued' }, failedSnapshot.items[1]] }
        accepted.idempotencyKey = body.params.idempotency_key
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'API_REQUEST_TIMEOUT', message: 'fixture simulates a committed retry with a lost response' })) })
      }
      if (body.params.idempotency_key !== accepted.idempotencyKey) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'CAMPAIGN_REVISION_CONFLICT', message: 'different key would conflict' })) })
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: accepted })) })
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_UNEXPECTED_METHOD', message: `Unexpected method ${body.method}` })) })
  })
  try {
    await page.goto(`${studioUrl}/campaign-lifecycle-browser-harness.html`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '打开高级控制' }).click()
    await expect(page.getByRole('option', { name: /失败/u })).toHaveCount(1)
    await page.getByRole('button', { name: '读取所选计划' }).click()
    await expect(page.getByText(/当前状态版本已读取/u)).toBeVisible()
    await page.getByRole('button', { name: /重试失败项 \(1\)/u }).click()
    const dialog = page.getByRole('dialog', { name: '确认重试失败项' })
    const failedItem = dialog.getByLabel(/商品任务 · jd · 店铺身份已确认/u).first()
    await expect(failedItem).toBeChecked()
    await dialog.getByLabel('操作原因').fill('核验后重试失败商品')
    await dialog.getByRole('checkbox').last().check()
    await dialog.getByRole('button', { name: '确认并提交' }).click()
    await expect(dialog.getByRole('status')).toContainText('提交结果尚未确认')
    await expect(dialog.getByRole('checkbox').first()).toBeDisabled()
    await expect(dialog.getByLabel('操作原因')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '按原参数重试' }).click()
    await expect(dialog).toBeHidden()
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ campaign_id: campaignId, expected_revision: '9', reason: '核验后重试失败商品', item_ids_json: '["item-failed-1"]' })
    expect(requests[1]).toEqual(requests[0])
    expect(requests[1].idempotency_key).toMatch(/^merchant:retry_failed:/u)
  } finally {
    await context.close()
  }
})

test('a definitive conflict after an unknown result unlocks close and reads back the same campaign', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const actionRequests = []
  const detailRequests = []
  let actionAttempt = 0
  const latest = campaign('running', 8)
  await page.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON()
    if (body.method === 'campaign.batch.list') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { items: [{ id: campaignId, state: 'running', revision: 7, platform: 'jd', accountId: 'store-1', itemCount: 1, failedCount: 0, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' }] } })) })
    if (body.method === 'campaign.batch.get') {
      detailRequests.push(body.params.campaign_id)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: latest })) })
    }
    if (body.method === 'campaign.batch.pause') {
      actionRequests.push(body.params)
      actionAttempt += 1
      if (actionAttempt === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'API_REQUEST_TIMEOUT', message: 'fixture simulates an unknown outcome' })) })
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'CAMPAIGN_REVISION_CONFLICT', message: '批量运营计划版本已变化，请刷新后重试' })) })
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_UNEXPECTED_METHOD', message: `Unexpected method ${body.method}` })) })
  })
  try {
    await page.goto(`${studioUrl}/campaign-lifecycle-browser-harness.html`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '打开高级控制' }).click()
    await page.getByRole('button', { name: '读取所选计划' }).click()
    await expect(page.getByText(/当前状态版本已读取/u)).toBeVisible()
    await page.getByRole('button', { name: '暂停' }).click()
    const dialog = page.getByRole('dialog', { name: '确认暂停批量任务' })
    await dialog.getByLabel('操作原因').fill('核对后暂停')
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: '确认并提交' }).click()
    await expect(dialog.getByRole('status')).toContainText('提交结果尚未确认')
    await dialog.getByRole('button', { name: '按原参数重试' }).click()
    await expect(dialog.getByRole('alert')).toContainText('版本已变化')
    await expect(dialog.getByRole('status')).toContainText(campaignId)
    await expect(dialog.getByRole('button', { name: '读取计划最新状态' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '取消' })).toBeEnabled()
    expect(actionRequests).toHaveLength(2)
    expect(actionRequests[0].idempotency_key).toBe(actionRequests[1].idempotency_key)
    await dialog.getByRole('button', { name: '读取计划最新状态' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText(/当前状态版本已读取/u)).toBeVisible()
    expect(detailRequests).toEqual([campaignId, campaignId])
    expect(actionRequests).toHaveLength(2)
  } finally {
    await context.close()
  }
})

test('selected campaign read failure keeps selection and retries the same detail', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const detailRequests = []
  let failFirstDetailRead = true
  const snapshot = {
    id: campaignId,
    state: 'running',
    revision: 12,
    items: [{ id: 'item-running-1', state: 'running', product_id: 'product-1', platform: 'jd', account_id: 'store-1' }],
  }
  await page.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON()
    if (body.method === 'campaign.batch.list') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { items: [{ id: campaignId, state: 'running', revision: 12, platform: 'jd', accountId: 'store-1', itemCount: 1, failedCount: 0, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' }] } })) })
    if (body.method === 'campaign.batch.get') {
      detailRequests.push(body.params)
      if (failFirstDetailRead) {
        failFirstDetailRead = false
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '合成批次读取暂不可用' })) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: snapshot })) })
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_UNEXPECTED_METHOD', message: `Unexpected method ${body.method}` })) })
  })
  try {
    await page.goto(`${studioUrl}/campaign-lifecycle-browser-harness.html`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '打开高级控制' }).click()
    await expect(page.getByRole('option', { name: /处理中/u })).toHaveCount(1)
    await expect(page.locator('#merchant-campaign-select')).toHaveValue(campaignId)
    await page.getByRole('button', { name: '读取所选计划' }).click()
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('读取暂不可用')
    await expect(page.locator('#merchant-campaign-select')).toHaveValue(campaignId)
    await alert.getByRole('button', { name: '重新读取' }).click()
    await expect(page.getByText(/当前状态版本已读取/u)).toBeVisible()
    await expect(page.locator('#merchant-campaign-select')).toHaveValue(campaignId)
    await expect(page.getByRole('button', { name: '暂停' })).toBeVisible()
    expect(detailRequests).toEqual([{ campaign_id: campaignId }, { campaign_id: campaignId }])
  } finally {
    await context.close()
  }
})
