import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_member_invite_recovery'
const envelope = (data, error = null) => ({ request_id: 'member-invite-recovery-fixture', trace_id: 'member-invite-recovery-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('an uncertain invite is refreshed and retried without creating a duplicate member row', async () => {
  test.setTimeout(60_000)
  const entryPath = '/__merchant-member-invite-recovery-entry.tsx'
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot,
    plugins: [react(), {
      name: 'merchant-member-invite-recovery-entry',
      resolveId(id) { if (id === entryPath) return '\0merchant-member-invite-recovery-entry' },
      load(id) {
        if (id !== '\0merchant-member-invite-recovery-entry') return
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
          if (req.url !== '/__merchant-members-invite-recovery') return next()
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
    throw new Error('Member invite recovery fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  const calls = []
  const members = []
  let inviteWrites = 0
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
    const path = url.pathname
    let data
    if (path === '/api/v1/auth/session') {
      data = envelope({ account: { id: 'invite-owner', login: 'owner@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })
    } else if (path === '/api/v1/auth/mcp-token') {
      data = envelope({ access_token: 'invite-recovery-token', refresh_token: 'invite-recovery-refresh', expires_in: 300, workspace_id: workspaceId })
    } else if (path === '/api/healthz') {
      data = envelope({ status: 'ok', writesEnabled: false, persistence: { mode: 'fixture', ready: true } })
    } else if (path === '/api/mcp') {
      const body = request.postDataJSON() ?? {}
      const method = body.method ?? ''
      const params = body.params ?? {}
      calls.push({ method, params, workspaceId: request.headers()['x-workspace-id'] })
      if (method === 'ops.session') {
        data = envelope({ result: { workspace_id: workspaceId, workbench: 'workspace', capabilities: ['workspace.member.read', 'workspace.member.manage'], assignable_roles: ['operator'] } })
      } else if (method === 'ops.members.list') {
        data = envelope({ result: { items: members.map(member => ({ ...member })), total: members.length, offset: Number(params.offset ?? 0), limit: Number(params.limit ?? 20), hasMore: false } })
      } else if (method === 'ops.member.upsert') {
        inviteWrites++
        const subject = String(params.external_subject)
        const existing = members.find(member => member.externalSubject === subject)
        if (!existing) members.push({ id: 'member-invite-once', externalSubject: subject, displayName: String(params.display_name ?? ''), role: String(params.role), status: 'invited', revision: 1, governance: { canChangeTarget: false, canDeactivateTarget: false } })
        if (inviteWrites === 1) {
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '邀请写入结果暂时未知' })) })
        }
        data = envelope({ result: { updated: true, member_id: existing?.id ?? 'member-invite-once' } })
      } else {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_METHOD', message: `Unexpected MCP method: ${method}` })) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_API', message: `Unexpected API: ${path}` })) })
  })

  try {
    await page.goto(`${studioUrl}/__merchant-members-invite-recovery`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('当前工作区还没有成员。')).toBeVisible()
    await page.getByLabel('成员登录账号').fill('new-member@example.invalid')
    await page.getByLabel('显示名').fill('邀请待核对成员')
    await page.getByLabel('角色').selectOption('operator')
    await page.getByLabel('邀请原因').fill('负责商品日常维护')
    await page.getByRole('button', { name: '邀请成员', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('已保留输入，请刷新成员列表后重试。')
    await expect(page.getByLabel('成员登录账号')).toHaveValue('new-member@example.invalid')
    expect(members).toHaveLength(1)

    await page.getByRole('button', { name: '刷新成员列表' }).click()
    const inviteRow = page.getByRole('row', { name: /邀请待核对成员/ })
    await expect(inviteRow).toContainText('待接受')
    await expect(page.getByText('共 1 位成员')).toBeVisible()
    await expect(page.getByLabel('成员登录账号')).toHaveValue('new-member@example.invalid')

    await page.getByRole('button', { name: '邀请成员', exact: true }).click()
    await expect(page.getByText('已邀请 邀请待核对成员。')).toBeVisible()
    await expect(page.getByRole('row', { name: /邀请待核对成员/ })).toContainText('待接受')
    await expect(page.getByText('共 1 位成员')).toBeVisible()
    expect(members).toHaveLength(1)
    expect(inviteWrites).toBe(2)
    expect(calls.filter(call => call.method === 'ops.member.upsert')).toEqual([
      { method: 'ops.member.upsert', params: { external_subject: 'new-member@example.invalid', display_name: '邀请待核对成员', role: 'operator', status: 'invited', reason: '负责商品日常维护' }, workspaceId },
      { method: 'ops.member.upsert', params: { external_subject: 'new-member@example.invalid', display_name: '邀请待核对成员', role: 'operator', status: 'invited', reason: '负责商品日常维护' }, workspaceId },
    ])
    expect(calls.filter(call => call.method === 'ops.members.list').length).toBeGreaterThanOrEqual(3)
    expect(pageErrors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
