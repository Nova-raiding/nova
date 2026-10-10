import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

const ticketId = '123e4567-e89b-12d3-a456-426614174000'
const ticket = {
  ticket_id: ticketId,
  ticket_number: 'SUP-20261011-001',
  status: 'in_progress',
  replayed: true,
  replies_path: `/v1/support/requests/${ticketId}`,
  submitted: true,
  subject: '首购目录无法打开',
  replies: [{ id: 'reply-1', body: '已恢复，请刷新后重试。', created_at: '2026-10-11T03:00:00.000Z' }],
}

describe('Merchant support request recovery journey', () => {
  let browser: Browser | undefined
  let vite: ViteDevServer | undefined
  let cacheDirectory: string | undefined
  let baseUrl = ''

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'merchant-support-mount-'))
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const entryPath = '/__merchant-support-test-entry.tsx'
    vite = await createServer({
      configFile: false,
      envDir: false,
      root,
      cacheDir: cacheDirectory,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
      plugins: [react(), {
        name: 'merchant-support-test-entry',
        resolveId(id: string) { if (id === entryPath) return '\0merchant-support-test-entry' },
        load(id: string) {
          if (id !== '\0merchant-support-test-entry') return
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { MerchantSupportRequestPanel } from '/src/MerchantSupportRequestPanel.tsx';
            import { activateMerchantWorkspace, configureMerchantWorkspaceScope } from '/src/api.ts';
            configureMerchantWorkspaceScope(['fixture-workspace'], 'fixture-workspace');
            activateMerchantWorkspace('fixture-workspace');
            createRoot(document.getElementById('root')).render(React.createElement(MerchantSupportRequestPanel, { baseUrl: '/api', workspaceKey: 'fixture-workspace:fixture-user', requestId: 'request-fixture', traceId: 'trace-fixture' }));
          `
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/__merchant-support-test') return next()
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`
            void server.transformIndexHtml(req.url, html).then(output => {
              res.setHeader('Content-Type', 'text/html; charset=utf-8')
              res.end(output)
            }).catch(next)
          })
        },
      }],
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Merchant support test listener did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  }, 60_000)

  afterAll(async () => {
    try { await browser?.close() }
    finally {
      try { await vite?.close() }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }) }
    }
  }, 60_000)

  it('restores an uncertain submit with the original idempotency key, then reads the customer-visible reply', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    page.setDefaultTimeout(10_000)
    const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
    const runtimeErrors: string[] = []
    let postCount = 0
    page.on('pageerror', error => runtimeErrors.push(error.message))
    try {
      await page.route(/\/api\/v1\/support\/requests/, async route => {
        const request = route.request()
        const method = request.method()
        if (method === 'POST') {
          const body = request.postDataJSON() as Record<string, unknown>
          requests.push({ method, path: new URL(request.url()).pathname, body })
          postCount += 1
          if (postCount === 1) {
            await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SUPPORT_REQUEST_OUTCOME_UNKNOWN', message: '登记结果待确认' } }) })
          } else {
            await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ workspace_id: 'fixture-workspace', data: { ...ticket, replayed: true }, error: null }) })
          }
          return
        }
        requests.push({ method, path: new URL(request.url()).pathname })
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ workspace_id: 'fixture-workspace', data: ticket, error: null }) })
      })
      await page.goto(`${baseUrl}/__merchant-support-test`, { waitUntil: 'commit' })
      await page.getByLabel('问题标题').fill('首购目录无法打开')
      await page.getByLabel('问题说明').fill('进入目录后页面一直显示加载中。')
      await page.getByRole('button', { name: '提交人工支持' }).click()
      await page.getByRole('alert').waitFor()
      expect(await page.getByLabel('问题标题').inputValue()).toBe('首购目录无法打开')
      await page.getByRole('button', { name: '用原标识恢复支持登记' }).click()
      await page.getByText(/已登记真实工单 SUP-20261011-001/).waitFor()

      expect(requests).toHaveLength(2)
      expect(requests[0].method).toBe('POST')
      expect(requests[0].path).toBe('/api/v1/support/requests')
      expect(requests[1].method).toBe('POST')
      expect(requests[1].path).toBe('/api/v1/support/requests')
      expect(requests[1].body).toEqual(requests[0].body)
      expect(requests[0].body).toMatchObject({ subject: '首购目录无法打开', message: '进入目录后页面一直显示加载中。', request_id: 'request-fixture', trace_id: 'trace-fixture' })
      expect(typeof requests[0].body?.idempotency_key).toBe('string')

      await page.getByLabel('已有支持工单 ID').fill(ticketId)
      await page.getByRole('button', { name: '查询本人客户可见回复' }).click()
      await page.getByText('已恢复，请刷新后重试。').waitFor()
      expect(requests.map(item => item.method)).toEqual(['POST', 'POST', 'GET'])
      expect(requests[2].path).toBe(`/api/v1/support/requests/${ticketId}`)
      expect(runtimeErrors).toEqual([])
    } finally { await page.close() }
  }, 45_000)
})
