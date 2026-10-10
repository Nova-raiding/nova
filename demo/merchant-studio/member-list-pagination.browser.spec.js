import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_member_list_pagination'
const envelope = (data, error = null) => ({ request_id: 'member-invite-enter', trace_id: 'member-invite-enter', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('member list pagination reads the next page and returns to the prior page without losing rows', async () => {
  test.setTimeout(60_000)
  const entryPath = '/__merchant-member-pagination-entry.tsx'
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot,
    plugins: [react(), {
      name: 'merchant-member-pagination-entry',
      resolveId(id) { if (id === entryPath) return '\0merchant-member-pagination-entry' },
      load(id) {
        if (id !== '\0merchant-member-pagination-entry') return
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { MerchantMembersPage } from '/src/MerchantMembersPage.tsx';
          import { activateMerchantWorkspace, configureMerchantWorkspaceScope } from '/src/api.ts';
          configureMerchantWorkspaceScope(['${workspaceId}'], '${workspaceId}');
          activateMerchantWorkspace('${workspaceId}');
          const account = { id: 'invite-owner', accountType: 'merchant', workspaceIds: ['${workspaceId}'] };
          createRoot(document.getElementById('root')).render(React.createElement(MerchantMembersPage, { baseUrl: '/api', account }));
        `
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__merchant-members-pagination') return next()
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
    throw new Error('Member Enter fixture failed to bind an ephemeral port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const calls = []
  const members = Array.from({ length: 21 }, (_, index) => ({ id: `member-${index + 1}`, externalSubject: `member-${index + 1}@example.invalid`, displayName: `成员 ${String(index + 1).padStart(2, '0')}`, role: 'operator', status: 'active', revision: 1, governance: { canChangeTarget: false, canDeactivateTarget: false } }))
  const externalRequests = []
  page.on('request', request => { if (new URL(request.url()).origin !== studioUrl) externalRequests.push(request.url()) })
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname
    let data
    if (path === '/api/v1/auth/session') {
      data = envelope({ account: { id: 'invite-owner', login: 'owner@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })
    } else if (path === '/api/v1/auth/mcp-token') {
      data = envelope({ access_token: 'member-pagination-token', refresh_token: 'member-pagination-refresh', expires_in: 300, workspace_id: workspaceId })
    } else if (path === '/api/healthz') {
      data = envelope({ status: 'ok', writesEnabled: false, persistence: { mode: 'fixture', ready: true } })
    } else if (path === '/api/mcp') {
      const body = request.postDataJSON() ?? {}
      const method = body.method ?? ''
      const params = body.params ?? {}
      calls.push({ method, params })
      if (method === 'ops.session') {
        data = envelope({ result: { workspace_id: workspaceId, workbench: 'workspace', capabilities: ['workspace.member.read', 'workspace.member.manage'], assignable_roles: ['operator'] } })
      } else if (method === 'ops.members.list') {
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? 20)
        data = envelope({ result: { items: members.slice(offset, offset + limit).map(member => ({ ...member })), total: members.length, offset, limit, hasMore: offset + limit < members.length } })
      } else if (method === 'ops.member.upsert') {
        const member = { id: 'member-enter-once', externalSubject: String(params.external_subject), displayName: String(params.display_name), role: String(params.role), status: 'invited', revision: 1, governance: { canChangeTarget: false, canDeactivateTarget: false } }
        members.push(member)
        data = envelope({ result: { updated: true, member_id: member.id } })
      } else {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_METHOD', message: `Unexpected MCP method: ${method}` })) })
      }
    } else {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_API', message: `Unexpected API: ${path}` })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
  })

  try {
    await page.goto(`${studioUrl}/__merchant-members-pagination`, { waitUntil: 'domcontentloaded' })
    const table = page.getByRole('table', { name: '工作区成员列表' })
    await expect(table.getByRole('row', { name: /成员 01/u })).toBeVisible()
    await expect(table.getByRole('row', { name: /成员 20/u })).toBeVisible()
    await expect(table.getByRole('row', { name: /成员 21/u })).toHaveCount(0)
    const previous = page.getByRole('button', { name: '上一页' })
    const next = page.getByRole('button', { name: '下一页' })
    await expect(previous).toBeDisabled()
    await expect(next).toBeEnabled()

    await next.click()
    await expect(table.getByRole('row', { name: /成员 21/u })).toBeVisible()
    await expect(table.getByRole('row', { name: /成员 01/u })).toHaveCount(0)
    await expect(previous).toBeEnabled()
    await expect(next).toBeDisabled()

    await previous.click()
    await expect(table.getByRole('row', { name: /成员 01/u })).toBeVisible()
    await expect(table.getByRole('row', { name: /成员 21/u })).toHaveCount(0)
    await expect(previous).toBeDisabled()
    await expect(next).toBeEnabled()
    expect(calls.filter(call => call.method === 'ops.members.list').map(call => call.params.offset)).toEqual(['0', '20', '0'])
    expect(calls.filter(call => call.method === 'ops.member.upsert' || call.method === 'ops.member.suspend')).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
