import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

test.setTimeout(120_000)

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_support_page_recovery'
const ticketId = 'ticket-support-page-recovery'
const envelope = (data, error = null) => ({ request_id: 'support-page-recovery', trace_id: 'support-page-recovery', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('a failed next support page keeps the current page and cursor for retry', async () => {
  const entryPath = '/__merchant-support-page-entry.tsx'
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react(), {
      name: 'merchant-support-page-test-entry',
      resolveId(id) { if (id === entryPath) return '\0merchant-support-page-entry' },
      load(id) {
        if (id !== '\0merchant-support-page-entry') return
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { CustomerSupportPanel } from '/src/App.tsx';
          import { activateMerchantWorkspace, configureMerchantWorkspaceScope } from '/src/api.ts';
          configureMerchantWorkspaceScope(['${workspaceId}'], '${workspaceId}');
          activateMerchantWorkspace('${workspaceId}');
          createRoot(document.getElementById('root')).render(React.createElement(CustomerSupportPanel, { apiBaseUrl: '/api', onClose: () => {} }));
        `
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__merchant-support-page-test') return next()
          const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`
          void server.transformIndexHtml(req.url, html).then(output => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(output)
          }).catch(next)
        })
      },
    }],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Support pagination fixture failed to bind an ephemeral port')
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
  const page = await context.newPage()
  page.setDefaultTimeout(5_000)
  const externalRequests = []
  const replyQueries = []
  let nextPageFailures = 1

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== `http://127.0.0.1:${address.port}`) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    if (url.pathname === '/api/v1/auth/mcp-token') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'support-page-token', refresh_token: 'support-page-refresh', expires_in: 300, workspace_id: workspaceId })) })
    }
    if (url.pathname === '/api/mcp') {
      const body = request.postDataJSON() ?? {}
      if (body.method === 'support.customer.replies.list') {
        const params = body.params ?? {}
        replyQueries.push(params)
        if (params.cursor && nextPageFailures > 0) {
          nextPageFailures -= 1
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '本地夹具：下一页暂时无法读取。' })) })
        }
        const secondPage = params.cursor === 'cursor-page-2'
        const result = secondPage
          ? { ticket: { ticket_number: 'SN-REPLY-22', subject: '下一页客户回复', status: 'open' }, replies: [{ id: 'reply-2', body: '第二页回复：资料已核实。', created_at: '2026-10-11T01:00:00.000Z' }], tickets: [], next_cursor: null }
          : { ticket: { ticket_number: 'SN-REPLY-22', subject: '下一页客户回复', status: 'open' }, replies: [{ id: 'reply-1', body: '第一页回复：已收到资料。', created_at: '2026-10-10T01:00:00.000Z' }], tickets: [], next_cursor: 'cursor-page-2' }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
      }
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_MCP', message: `Unexpected MCP method: ${String(body.method)}` })) })
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_API', message: `Unexpected API: ${url.pathname}` })) })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/__merchant-support-page-test`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const panel = page.getByRole('dialog', { name: '支持消息' })
    await expect(panel).toBeVisible()
    await panel.getByLabel('客服工单 ID').fill(ticketId)
    await panel.getByRole('button', { name: '读取客户回复' }).click()
    await expect(panel).toContainText('第一页回复：已收到资料。')
    const nextPage = panel.getByRole('button', { name: '读取下一页客户回复' })
    await expect(nextPage).toBeVisible()

    await nextPage.click()
    await expect(panel.getByRole('alert')).toContainText('支持消息读取失败')
    await expect(panel).toContainText('SN-REPLY-22 · 下一页客户回复 · open')
    await expect(panel).toContainText('第一页回复：已收到资料。')
    await expect(nextPage).toBeVisible()
    expect(replyQueries).toEqual([
      { ticket_id: ticketId, limit: '50' },
      { ticket_id: ticketId, limit: '50', cursor: 'cursor-page-2' },
    ])

    await nextPage.click()
    await expect(panel).toContainText('第二页回复：资料已核实。')
    await expect(panel.getByText('第一页回复：已收到资料。')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '读取下一页客户回复' })).toHaveCount(0)
    expect(replyQueries[2]).toEqual({ ticket_id: ticketId, limit: '50', cursor: 'cursor-page-2' })
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
