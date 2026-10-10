import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

test.setTimeout(120_000)

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_member_role_denial'
const envelope = (data, error = null) => ({
  request_id: 'member-role-denial',
  trace_id: 'member-role-denial',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error,
})

test('a denied role change keeps the draft until refreshed and explicitly retried', async () => {
  const entryPath = '/__merchant-member-role-entry.tsx'
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react(), {
      name: 'merchant-member-role-test-entry',
      resolveId(id) { if (id === entryPath) return '\0merchant-member-role-entry' },
      load(id) {
        if (id !== '\0merchant-member-role-entry') return
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { MerchantMembersPage } from '/src/MerchantMembersPage.tsx';
          import { activateMerchantWorkspace, configureMerchantWorkspaceScope } from '/src/api.ts';
          configureMerchantWorkspaceScope(['${workspaceId}'], '${workspaceId}');
          activateMerchantWorkspace('${workspaceId}');
          const account = { accountType: 'merchant', workspaceIds: ['${workspaceId}'] };
          createRoot(document.getElementById('root')).render(React.createElement(MerchantMembersPage, { baseUrl: '/api', account }));
        `
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__merchant-members-role-test') return next()
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
    throw new Error('Member role fixture failed to bind an ephemeral port')
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(5_000)
  const calls = []
  let member = { id: 'member-1', externalSubject: 'operator@example.invalid', displayName: '运营成员', role: 'operator', status: 'active', revision: 4, governance: { canChangeTarget: true, canDeactivateTarget: false } }
  let roleWriteCount = 0

  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/auth/session') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'member-role-owner', login: 'owner@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    }
    if (path === '/api/v1/auth/mcp-token') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'member-role-token', refresh_token: 'member-role-refresh', expires_in: 300, workspace_id: workspaceId })) })
    }
    if (path === '/api/healthz') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, persistence: { mode: 'fixture', ready: true } })) })
    if (path === '/api/mcp') {
      const request = route.request().postDataJSON() ?? {}
      const method = request.method ?? ''
      const params = request.params ?? {}
      calls.push({ method, params, workspaceId: route.request().headers()['x-workspace-id'] })
      if (method === 'ops.session') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { workspace_id: workspaceId, workbench: 'workspace', capabilities: ['workspace.member.read', 'workspace.member.manage'], assignable_roles: ['operator', 'finance'] } })) })
      }
      if (method === 'ops.members.list') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { items: [{ ...member }], total: 1, offset: Number(params.offset ?? 0), limit: Number(params.limit ?? 20), hasMore: false } })) })
      }
      if (method === 'ops.member.upsert') {
        roleWriteCount += 1
        if (roleWriteCount === 1) {
          return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'MEMBER_ROLE_FORBIDDEN', message: '当前账号无权调整该成员角色。' })) })
        }
        member = { ...member, role: String(params.role), revision: member.revision + 1 }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { updated: true } })) })
      }
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_METHOD', message: `Unexpected MCP method: ${method}` })) })
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_API', message: `Unexpected API: ${path}` })) })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/__merchant-members-role-test`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('row', { name: /运营成员/ })).toContainText('运营')
    await page.getByRole('button', { name: '调整 运营成员 的角色' }).click()
    const action = page.getByRole('form', { name: '成员变更' })
    await action.getByLabel('新角色').selectOption('finance')
    await action.getByLabel('操作原因').fill('负责月度账务核对')
    await action.getByRole('button', { name: '确认改角色' }).click()

    await expect(page.getByRole('alert')).toContainText('当前账号无权调整该成员角色')
    await expect(action.getByLabel('新角色')).toHaveValue('finance')
    await expect(action.getByLabel('操作原因')).toHaveValue('负责月度账务核对')
    await expect(page.getByRole('row', { name: /运营成员/ })).toContainText('运营')
    expect(roleWriteCount).toBe(1)

    await page.getByRole('button', { name: '刷新成员列表' }).click()
    await expect(page.getByRole('row', { name: /运营成员/ })).toContainText('运营')
    await expect(action.getByLabel('新角色')).toHaveValue('finance')
    expect(roleWriteCount).toBe(1)

    await action.getByRole('button', { name: '确认改角色' }).click()
    await expect(page.getByRole('row', { name: /运营成员/ })).toContainText('财务')
    expect(roleWriteCount).toBe(2)
    expect(calls.filter(call => call.method === 'ops.member.upsert')).toEqual([
      { method: 'ops.member.upsert', params: { external_subject: 'operator@example.invalid', display_name: '运营成员', role: 'finance', expected_revision: '4', reason: '负责月度账务核对' }, workspaceId },
      { method: 'ops.member.upsert', params: { external_subject: 'operator@example.invalid', display_name: '运营成员', role: 'finance', expected_revision: '4', reason: '负责月度账务核对' }, workspaceId },
    ])
    expect(member).toMatchObject({ role: 'finance', revision: 5 })
    expect(calls.filter(call => call.method === 'ops.members.list').length).toBeGreaterThanOrEqual(2)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
