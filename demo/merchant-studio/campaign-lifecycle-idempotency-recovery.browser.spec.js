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
    await dialog.getByRole('button', { name: '确认并提交' }).click()
    await expect(dialog).toBeHidden()
    expect(requests).toHaveLength(2)
    expect(requests[0].idempotency_key).toMatch(/^merchant:pause:/u)
    expect(requests[1].idempotency_key).toBe(requests[0].idempotency_key)
    expect(requests[1]).toMatchObject({ campaign_id: campaignId, expected_revision: '7', reason: '核对后暂停' })
  } finally {
    await context.close()
  }
})
