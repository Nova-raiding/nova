import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_member_list_read_recovery'
const envelope = (data, error = null) => ({ request_id: 'member-list-read-recovery', trace_id: 'member-list-read-recovery', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

for (const failure of ['unavailable', 'wrong_workspace']) {
test(`member session ${failure} can recover without a permanent switching state or member writes`, async () => {
  test.setTimeout(60_000)
  const entryPath = '/__merchant-member-read-recovery-entry.tsx'
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot,
    plugins: [react(), {
      name: 'merchant-member-read-recovery-entry',
      resolveId(id) { if (id === entryPath) return '\0merchant-member-read-recovery-entry' },
      load(id) {
        if (id !== '\0merchant-member-read-recovery-entry') return
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { MerchantMembersPage } from '/src/MerchantMembersPage.tsx';
          import { activateMerchantWorkspace, configureMerchantWorkspaceScope } from '/src/api.ts';
          configureMerchantWorkspaceScope(['${workspaceId}'], '${workspaceId}');
          activateMerchantWorkspace('${workspaceId}');
          const account = { id: 'member-reader', accountType: 'merchant', workspaceIds: ['${workspaceId}'] };
          createRoot(document.getElementById('root')).render(React.createElement(MerchantMembersPage, { baseUrl: '/api', account }));
        `
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__merchant-member-read-recovery') return next()
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
    throw new Error('Member list recovery fixture did not bind an ephemeral port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const calls = []
  const pageErrors = []
  const externalRequests = []
  let listReads = 0
  let sessionReads = 0
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== studioUrl) externalRequests.push(request.url())
  })
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    let data
    if (url.pathname === '/api/v1/auth/session') {
      data = envelope({ account: { id: 'member-reader', login: 'reader@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })
    } else if (url.pathname === '/api/v1/auth/mcp-token') {
      data = envelope({ access_token: 'member-read-token', refresh_token: 'member-read-refresh', expires_in: 300, workspace_id: workspaceId })
    } else if (url.pathname === '/api/healthz') {
      data = envelope({ status: 'ok', writesEnabled: false, persistence: { mode: 'fixture', ready: true } })
    } else if (url.pathname === '/api/mcp') {
      const body = request.postDataJSON() ?? {}
      const method = body.method ?? ''
      const params = body.params ?? {}
      calls.push({ method, params, workspaceId: request.headers()['x-workspace-id'] })
      if (method === 'ops.session') {
        sessionReads += 1
        if (sessionReads === 1 && failure === 'unavailable') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '成员会话暂不可用' })) })
        if (sessionReads === 1 && failure === 'wrong_workspace') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { workspace_id: 'ws_foreign', workbench: 'workspace', capabilities: ['workspace.member.read', 'workspace.member.manage'], assignable_roles: ['operator'] } })) })
        data = envelope({ result: { workspace_id: workspaceId, workbench: 'workspace', capabilities: ['workspace.member.read', 'workspace.member.manage'], assignable_roles: ['operator'] } })
      } else if (method === 'ops.members.list') {
        listReads += 1
        data = envelope({ result: { items: [{ id: 'member-readback-1', externalSubject: 'recovered@example.invalid', displayName: '恢复后可见成员', role: 'operator', status: 'active', revision: 2, governance: { canChangeTarget: false, canDeactivateTarget: false } }], total: 1, offset: Number(params.offset ?? 0), limit: Number(params.limit ?? 20), hasMore: false } })
      } else {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_METHOD', message: `Unexpected MCP method: ${method}` })) })
      }
    } else {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_API', message: `Unexpected API: ${url.pathname}` })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
  })

  try {
    await page.goto(`${studioUrl}/__merchant-member-read-recovery`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('alert')).toContainText(failure === 'unavailable' ? '服务暂不可用' : '没有可验证的商家工作区范围')
    await expect(page.getByRole('status').filter({ hasText: '正在切换工作区' })).toHaveCount(0)
    await expect(page.getByRole('table', { name: '工作区成员列表' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '刷新成员列表' })).toBeEnabled()
    await expect(page.getByRole('form', { name: '邀请工作区成员' })).toHaveCount(0)
    expect(calls.filter(call => call.method === 'ops.member.upsert' || call.method === 'ops.member.suspend')).toEqual([])

    await page.getByRole('button', { name: '刷新成员列表' }).click()
    await expect(page.getByRole('table', { name: '工作区成员列表' }).getByRole('row', { name: /恢复后可见成员/u })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('form', { name: '邀请工作区成员' })).toBeVisible()
    expect(calls.filter(call => call.method === 'ops.members.list')).toEqual([
      { method: 'ops.members.list', params: { limit: '20', offset: '0' }, workspaceId },
    ])
    expect(calls.filter(call => call.method === 'ops.member.upsert' || call.method === 'ops.member.suspend')).toEqual([])
    expect(sessionReads).toBe(2)
    expect(listReads).toBe(1)
    expect(pageErrors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})

}
