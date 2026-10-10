import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_rights_adjust_fixture'
const assetId = 'asset_rights_adjust_fixture'
const name = '已授权后调整范围.png'
const envelope = (data, error = null) => ({ request_id: 'material-rights-adjust', trace_id: 'material-rights-adjust', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('adjusting approved material rights requires acknowledgement and updates the visible scope', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    optimizeDeps: { include: ['react', 'react-dom/client', 'antd'] },
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Material rights fixture failed to bind an ephemeral port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const writes = []
  const externalRequests = []

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    if (url.pathname === `/api/v1/assets/${assetId}/rights` && request.method() === 'PUT') {
      writes.push(request.postDataJSON())
      const body = request.postDataJSON()
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        id: assetId, workspaceId, name, mimeType: 'image/png', sizeBytes: 1024,
        sha256: 'a'.repeat(64), scanStatus: 'clean', parseStatus: 'succeeded',
        rightsStatus: body.rights_status, rightsScope: body.rights_scope, revision: 8,
        source: 'merchant_upload', references: [],
        readiness: { status: 'draft', reasons: ['权益范围受限'] },
        display: { primaryStatus: 'rights_blocked', label: '仅内部使用', sourceState: 'blocked', reasons: ['权益范围受限'], nextAction: { method: 'asset.rights.update', label: '调整权益范围', allowed: true } },
      })) })
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '本地夹具仅允许权益更新' })) })
  })

  try {
    await page.goto(`${origin}/material-rights-adjust-fixture.html`, { waitUntil: 'domcontentloaded' })
    const control = page.getByTestId(`material-rights-${assetId}`)
    await expect(control.getByRole('status')).toHaveText('商用权益已确认')
    await control.getByRole('button', { name: `调整权益范围：${name}` }).click()
    let dialog = page.getByRole('dialog', { name: `调整权益范围：“${name}”` })
    await expect(dialog.getByRole('button', { name: '保存权益范围' })).toBeDisabled()
    await dialog.getByRole('button', { name: /取\s*消/u }).click()
    await expect(dialog).toHaveCount(0)
    expect(writes).toEqual([])

    await control.getByRole('button', { name: `调整权益范围：${name}` }).click()
    dialog = page.getByRole('dialog', { name: `调整权益范围：“${name}”` })
    await dialog.getByLabel('选择权益范围').click()
    const internalScope = page.locator('.ant-select-item-option').filter({ hasText: '仅内部使用' })
    await internalScope.scrollIntoViewIfNeeded()
    await internalScope.click()
    await dialog.getByRole('checkbox', { name: '我已核对授权证明，并确认所选权益范围准确' }).check()
    await dialog.getByRole('button', { name: '保存权益范围' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(control.getByRole('status')).toHaveText('仅内部使用，不可用于生成')
    expect(writes).toEqual([{ rights_status: 'approved', rights_scope: 'internal_only', usage_scopes: ['internal_only'], ai_modification_allowed: false }])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
