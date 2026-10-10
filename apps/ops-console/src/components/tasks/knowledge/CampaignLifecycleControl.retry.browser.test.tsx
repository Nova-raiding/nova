import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'

describe('Campaign lifecycle retry interaction', () => {
  let browser: Browser | undefined
  let vite: ViteDevServer | undefined
  let cacheDirectory = ''
  let baseUrl = ''

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(resolve(tmpdir(), 'ops-campaign-retry-'))
    const entry = '/__campaign-retry-entry.tsx'
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'),
      cacheDir: cacheDirectory,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: 'campaign-retry-rpc-mock',
        enforce: 'pre',
        transform(code, id) {
          if (!id.includes('CampaignLifecycleControl.tsx')) return
          const rpcImport = "import { describeOpsError, rpc } from '../../../api/opsClient.js'"
          if (!code.includes(rpcImport)) throw new Error('Campaign lifecycle RPC boundary not found')
          return code.replace(rpcImport, 'const describeOpsError = error => String(error); const rpc = (method, params) => window.__campaignRpcMock(method, params)')
        },
        resolveId(id) { if (id === entry) return `\0${entry}` },
        load(id) {
          if (id === `\0${entry}`) return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { CampaignLifecycleControl } from '/src/components/tasks/knowledge/CampaignLifecycleControl.tsx';
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(CampaignLifecycleControl, { canControl: true })));
          `
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/__campaign-retry') return next()
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(output) }).catch(next)
          })
        },
      }],
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Campaign lifecycle test server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await vite?.close()
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true })
  }, 60_000)

  it('reuses the same idempotency key when the operator retries an ambiguous timeout', async () => {
    const page = await browser!.newPage()
    await page.addInitScript(() => {
      window.__campaignMutationCalls = []
      let mutationAttempt = 0
      window.__campaignRpcMock = async (method: string, params?: unknown) => {
        if (method === 'campaign.batch.get') return { id: 'campaign-ui', state: 'running', revision: 4, items: [] }
        if (method === 'campaign.batch.pause') {
          window.__campaignMutationCalls!.push(params)
          mutationAttempt += 1
          if (mutationAttempt === 1) throw new Error('network timeout after request')
          return { id: 'campaign-ui', state: 'paused', revision: 5, items: [] }
        }
        throw new Error(`Unexpected RPC: ${method}`)
      }
    })
    try {
      await page.goto(`${baseUrl}/__campaign-retry`)
      await page.getByRole('textbox', { name: 'Campaign ID' }).fill('campaign-ui')
      await page.getByRole('button', { name: '读取真实状态' }).click()
      await page.getByText('campaign-ui · running').waitFor()
      await page.getByRole('button', { name: '暂停后续操作' }).click()
      await page.locator('.ant-modal textarea').fill('确认暂停后续运营')
      await page.getByRole('checkbox', { name: /我已核对 Campaign/ }).check()
      await page.getByRole('button', { name: '确认并提交' }).click()
      await page.getByText('network timeout after request').waitFor()
      await page.getByRole('button', { name: '再次提交暂停操作' }).click()
      await page.getByText('campaign-ui · paused').waitFor()
      const calls = await page.evaluate(() => window.__campaignMutationCalls)
      expect(calls).toHaveLength(2)
      expect((calls![1] as { idempotency_key: string }).idempotency_key).toBe((calls![0] as { idempotency_key: string }).idempotency_key)
    } finally {
      await page.close()
    }
  }, 60_000)
})

declare global {
  interface Window {
    __campaignMutationCalls?: unknown[]
    __campaignRpcMock?: (method: string, params?: unknown) => Promise<unknown>
  }
}
