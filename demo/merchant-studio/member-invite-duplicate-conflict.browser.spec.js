import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_member_invite_duplicate_conflict'
const envelope = (data, error = null) => ({ request_id: 'member-invite-enter', trace_id: 'member-invite-enter', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('duplicate member invite conflict preserves the draft and refreshes authoritative membership', async () => {
  test.setTimeout(60_000)
  const entryPath = '/__merchant-member-enter-entry.tsx'
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot,
    plugins: [react(), {
      name: 'merchant-member-enter-entry',
      resolveId(id) { if (id === entryPath) return '\0merchant-member-enter-entry' },
      load(id) {
        if (id !== '\0merchant-member-enter-entry') return
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
          if (req.url !== '/__merchant-members-enter') return next()
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
  const members = [{ id: 'existing-member-1', externalSubject: 'existing-member@example.invalid', displayName: '既有成员', role: 'operator', status: 'active', revision: 4, governance: { canChangeTarget: false, canDeactivateTarget: false } }]
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
      data = envelope({ access_token: 'member-enter-token', refresh_token: 'member-enter-refresh', expires_in: 300, workspace_id: workspaceId })
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
        data = envelope({ result: { items: members.map(member => ({ ...member })), total: members.length, offset: Number(params.offset ?? 0), limit: Number(params.limit ?? 20), hasMore: false } })
      } else if (method === 'ops.member.upsert') {
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'MEMBER_ALREADY_EXISTS', message: '此账号已是当前工作区成员' })) })
      } else {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_METHOD', message: `Unexpected MCP method: ${method}` })) })
      }
    } else {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_API', message: `Unexpected API: ${path}` })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
  })

  try {
    await page.goto(`${studioUrl}/__merchant-members-enter`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('row', { name: /既有成员/u })).toBeVisible()
    const subject = page.getByLabel('成员登录账号')
    const displayName = page.getByLabel('显示名')
    const role = page.getByLabel('角色')
    const reason = page.getByLabel('邀请原因')
    await subject.fill('existing-member@example.invalid')
    await displayName.fill('重复邀请草稿')
    await reason.fill('误重复邀请，核对现有成员状态')
    await expect(role).toHaveValue('operator')
    await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '邀请成员', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('成员操作失败')
    await expect(page.getByRole('alert')).toContainText('已保留输入')
    await expect(subject).toHaveValue('existing-member@example.invalid')
    await expect(displayName).toHaveValue('重复邀请草稿')
    await expect(reason).toHaveValue('误重复邀请，核对现有成员状态')
    await expect(page.getByRole('row', { name: /既有成员/u })).toContainText('已激活')
    await page.getByRole('button', { name: '刷新成员列表' }).click()
    await expect(page.getByRole('row', { name: /既有成员/u })).toBeVisible()
    await expect(page.getByRole('row', { name: /重复邀请草稿/u })).toHaveCount(0)
    expect(calls.filter(call => call.method === 'ops.member.upsert')).toEqual([{
      method: 'ops.member.upsert',
      params: { external_subject: 'existing-member@example.invalid', display_name: '重复邀请草稿', role: 'operator', status: 'invited', reason: '误重复邀请，核对现有成员状态' },
    }])
    expect(members).toHaveLength(1)
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
