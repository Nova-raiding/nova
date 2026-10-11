import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_member_invite_reason_validation'
const envelope = (data, error = null) => ({ request_id: 'member-invite-reason-validation', trace_id: 'member-invite-reason-validation', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('member invite reason length is measured after trimming and blocks writes until valid', async () => {
  test.setTimeout(60_000)
  const entryPath = '/__merchant-member-reason-entry.tsx'
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot,
    plugins: [react(), {
      name: 'merchant-member-reason-entry',
      resolveId(id) { if (id === entryPath) return '\0merchant-member-reason-entry' },
      load(id) {
        if (id !== '\0merchant-member-reason-entry') return
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
          if (req.url !== '/__merchant-member-reason') return next()
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
    throw new Error('Member reason fixture failed to bind an ephemeral port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const writes = []
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
    let data
    if (url.pathname === '/api/v1/auth/session' && request.method() === 'GET') {
      data = envelope({ account: { id: 'invite-owner', login: 'owner@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })
    } else if (url.pathname === '/api/v1/auth/mcp-token' && request.method() === 'POST') {
      data = envelope({ access_token: 'member-reason-token', refresh_token: 'member-reason-refresh', expires_in: 300, workspace_id: workspaceId })
    } else if (url.pathname === '/api/healthz' && request.method() === 'GET') {
      data = envelope({ status: 'ok', writesEnabled: false, persistence: { mode: 'fixture', ready: true } })
    } else if (url.pathname === '/api/mcp' && request.method() === 'POST') {
      const body = request.postDataJSON() ?? {}
      if (body.method === 'ops.session') data = envelope({ result: { workspace_id: workspaceId, workbench: 'workspace', capabilities: ['workspace.member.read', 'workspace.member.manage'], assignable_roles: ['operator'] } })
      else if (body.method === 'ops.members.list') data = envelope({ result: { items: [], total: 0, offset: 0, limit: 20, hasMore: false } })
      else {
        writes.push(body)
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: 'Member mutations are not allowed in this validation journey.' })) })
      }
    } else {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_REQUEST_BLOCKED', message: 'Unexpected request blocked.' })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
  })

  try {
    await page.goto(`${studioUrl}/__merchant-member-reason`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('当前工作区还没有成员。')).toBeVisible()
    await page.getByLabel('成员登录账号').fill('reason-check@example.invalid')
    await page.getByLabel('角色').selectOption('operator')
    const reason = page.getByLabel('邀请原因')
    const submit = page.getByRole('button', { name: '邀请成员', exact: true })

    await reason.fill(' abc ')
    await expect(submit).toBeDisabled()
    await expect(reason).toHaveValue(' abc ')
    expect(writes).toEqual([])

    await reason.fill('abcd')
    await expect(submit).toBeEnabled()
    expect(writes).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
