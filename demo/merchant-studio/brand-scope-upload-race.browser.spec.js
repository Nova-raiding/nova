import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_brand_scope_upload_race'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=', 'base64')
const envelope = data => ({ request_id: 'brand-scope-upload-race', trace_id: 'brand-scope-upload-race', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('a delayed brand asset upload cannot cross store scopes or replace a newer draft', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') { await vite.close(); throw new Error('Brand scope race fixture failed to bind an ephemeral port') }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const releaseUploads = []
  let uploadAttempts = 0
  let savedSettings
  let serverSettings = {
    schemaVersion: 1,
    global: { enabled: true, values: {} },
    stores: {
      'store-a': { enabled: true, values: { persona: 'A 服务端画像' } },
      'store-b': { enabled: true, values: { persona: 'B 服务端画像' } },
    }, series: {}, images: {},
  }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/api/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    else if (path === '/api/v1/auth/session') data = { account: { id: 'brand-scope-user', login: 'brand-scope@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/api/v1/platform-accounts') data = { items: [
      { platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'store-a', storeName: '店铺 A' },
      { platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'store-b', storeName: '店铺 B' },
    ] }
    else if (path === '/api/v1/brand-scopes' && route.request().method() === 'PUT') {
      savedSettings = route.request().postDataJSON()?.settings
      serverSettings = savedSettings
      data = { settings: savedSettings, revision: 2, updated_at: '2026-10-10T00:01:00.000Z', series: [], assignments: [] }
    }
    else if (path === '/api/v1/brand-scopes') data = { settings: serverSettings, revision: 1, updated_at: null, series: [], assignments: [] }
    else if (path === '/api/v1/assets' || path === '/api/v1/assets/') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/api/v1/assets/upload') {
      uploadAttempts += 1
      const attempt = uploadAttempts
      await new Promise(resolve => { releaseUploads[attempt - 1] = resolve })
      data = { id: `asset-delayed-logo-${attempt}`, workspaceId, name: `delayed-logo-${attempt}.png`, mimeType: 'image/png', sizeBytes: png.length, sha256: 'd'.repeat(64), scanStatus: 'unscanned', rightsStatus: 'pending', source: 'merchant_upload', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' }
    } else if (path === '/api/mcp') {
      const method = route.request().postDataJSON()?.method
      data = { result: method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 10 } : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] } : method === 'workspace.metrics' ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } } : { items: [], total: 0, limit: 50, offset: 0 } }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/products?section=assets`, { waitUntil: 'domcontentloaded' })
    const storePicker = page.getByRole('button', { name: '选择配置店铺' })
    await expect(page.getByRole('region', { name: '品牌资产配置' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '店铺 A用户画像' })).toHaveValue('A 服务端画像')
    const logoInput = page.locator('.material-brand-logo-field input[type="file"]').nth(1)
    await logoInput.setInputFiles({ name: 'delayed-logo.png', mimeType: 'image/png', buffer: png })
    await expect.poll(() => uploadAttempts).toBe(1)

    await storePicker.click()
    await page.getByRole('option', { name: '店铺 B' }).click()
    const persona = page.getByRole('textbox', { name: '店铺 B用户画像' })
    await expect(persona).toHaveValue('B 服务端画像')
    await persona.fill('B 上传期间的新画像')

    releaseUploads[0]()
    await expect(page.getByRole('status').filter({ hasText: '配置范围已切换，本次未写入品牌配置' })).toBeVisible()
    await expect(persona).toHaveValue('B 上传期间的新画像')
    await page.getByRole('button', { name: '保存品牌配置' }).click()
    await expect.poll(() => savedSettings).not.toBeUndefined()
    expect(savedSettings.stores['store-a'].values.persona).toBe('A 服务端画像')
    expect(savedSettings.stores['store-a'].values.logoAssetId).toBeUndefined()
    expect(savedSettings.stores['store-b'].values.persona).toBe('B 上传期间的新画像')
    expect(savedSettings.stores['store-b'].values.logoAssetId).toBeUndefined()

    const firstSave = structuredClone(savedSettings)
    await storePicker.click()
    await page.getByRole('option', { name: '店铺 A' }).click()
    await expect(page.getByRole('textbox', { name: '店铺 A用户画像' })).toHaveValue('A 服务端画像')
    await logoInput.setInputFiles({ name: 'delayed-logo.png', mimeType: 'image/png', buffer: png })
    await expect.poll(() => uploadAttempts).toBe(2)
    await storePicker.click()
    await page.getByRole('option', { name: '店铺 B' }).click()
    await storePicker.click()
    await page.getByRole('option', { name: '店铺 A' }).click()
    const editedOldScope = page.getByRole('textbox', { name: '店铺 A用户画像' })
    await editedOldScope.fill('A 范围切换后新画像')
    releaseUploads[1]()
    await expect(page.getByRole('status').filter({ hasText: '配置范围已切换，本次未写入品牌配置' })).toBeVisible()
    await expect(editedOldScope).toHaveValue('A 范围切换后新画像')
    await page.getByRole('button', { name: '保存品牌配置' }).click()
    await expect.poll(() => savedSettings?.stores?.['store-a']?.values?.persona).toBe('A 范围切换后新画像')
    expect(savedSettings.stores['store-a'].values.logoAssetId).toBeUndefined()
    expect(savedSettings.stores['store-b']).toEqual(firstSave.stores['store-b'])
  } finally {
    for (const release of releaseUploads) release?.()
    await context.close()
    await browser.close()
    await vite.close()
  }
})

test('discarding a store draft keeps save disabled until the new scope read finishes', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') { await vite.close(); throw new Error('Brand scope loading fixture failed to bind an ephemeral port') }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let releaseScopeRead
  let scopeReads = 0
  let delayNextScopeRead = false
  let saves = 0
  const settings = {
    schemaVersion: 1, global: { enabled: true, values: {} },
    stores: {
      'store-a': { enabled: true, values: { persona: 'A 服务端画像' } },
      'store-b': { enabled: true, values: { persona: 'B 服务端画像' } },
    }, series: {}, images: {},
  }
  const respond = data => ({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/api/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    else if (path === '/api/v1/auth/session') data = { account: { id: 'brand-scope-user', login: 'brand-scope@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/api/v1/platform-accounts') data = { items: [
      { platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'store-a', storeName: '店铺 A' },
      { platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'store-b', storeName: '店铺 B' },
    ] }
    else if (path === '/api/v1/brand-scopes' && request.method() === 'GET') {
      scopeReads += 1
      if (delayNextScopeRead) {
        delayNextScopeRead = false
        await new Promise(resolve => { releaseScopeRead = resolve })
      }
      data = { settings, revision: scopeReads, updated_at: null, series: [], assignments: [] }
    } else if (path === '/api/v1/brand-scopes' && request.method() === 'PUT') {
      saves += 1
      data = { settings: request.postDataJSON()?.settings ?? settings, revision: 3, updated_at: '2026-10-10T00:01:00.000Z', series: [], assignments: [] }
    } else if (path === '/api/v1/assets' || path === '/api/v1/assets/') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 10 } : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] } : method === 'workspace.metrics' ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } } : { items: [], total: 0, limit: 50, offset: 0 } }
    }
    return route.fulfill(respond(data))
  })
  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/products?section=assets`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: '品牌资产配置' })).toBeVisible()
    await page.getByRole('textbox', { name: '店铺 A用户画像' }).fill('A 尚未保存的新画像')
    const picker = page.getByRole('button', { name: '选择配置店铺' })
    await picker.click()
    await page.getByRole('option', { name: '店铺 B' }).click()
    delayNextScopeRead = true
    await page.getByRole('button', { name: '放弃草稿并切换' }).click()
    const saveButton = page.getByRole('button', { name: '正在读取品牌配置…' })
    await expect(saveButton).toBeDisabled()
    await expect.poll(() => scopeReads).toBeGreaterThan(1)
    await saveButton.click({ force: true })
    expect(saves).toBe(0)
    releaseScopeRead()
    await expect(page.getByRole('textbox', { name: '店铺 B用户画像' })).toHaveValue('B 服务端画像')
    expect(saves).toBe(0)
  } finally {
    releaseScopeRead?.()
    await context.close()
    await browser.close()
    await vite.close()
  }
})
