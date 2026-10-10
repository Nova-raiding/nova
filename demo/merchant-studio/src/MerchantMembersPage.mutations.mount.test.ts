import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

type FixtureMember = { id: string; externalSubject: string; displayName: string; role: string; status: string; revision: number; governance: { canChangeTarget: boolean; canDeactivateTarget: boolean } }

describe('MerchantMembersPage mutations', () => {
  let browser: Browser | undefined
  let vite: ViteDevServer | undefined
  let cacheDirectory: string | undefined
  let baseUrl = ''

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'merchant-members-mutation-mount-'))
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const entryPath = '/__merchant-members-mutations-entry.tsx'
    vite = await createServer({
      configFile: false,
      envDir: false,
      root,
      cacheDir: cacheDirectory,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
      plugins: [react(), {
        name: 'merchant-members-mutations-test-entry',
        resolveId(id: string) { if (id === entryPath) return '\0merchant-members-mutations-entry' },
        load(id: string) {
          if (id !== '\0merchant-members-mutations-entry') return
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { MerchantMembersPage } from '/src/MerchantMembersPage.tsx';
            import { activateMerchantWorkspace, configureMerchantWorkspaceScope } from '/src/api.ts';
            configureMerchantWorkspaceScope(['ws_members_fixture'], 'ws_members_fixture');
            activateMerchantWorkspace('ws_members_fixture');
            const account = { accountType: 'merchant', workspaceIds: ['ws_members_fixture'] };
            createRoot(document.getElementById('root')).render(React.createElement(MerchantMembersPage, { baseUrl: '/api', account }));
          `
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/__merchant-members-mutations-test') return next()
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
    if (!address || typeof address === 'string') throw new Error('Merchant members test listener did not bind')
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

  it('invites a member, reads it back, changes the role, then suspends with revisioned reasons', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    page.setDefaultTimeout(10_000)
    const calls: Array<{ method: string; params: Record<string, unknown>; workspaceId?: string }> = []
    const members: FixtureMember[] = [{ id: 'member_existing', externalSubject: 'existing@example.test', displayName: '现有成员', role: 'operator', status: 'active', revision: 4, governance: { canChangeTarget: true, canDeactivateTarget: true } }]
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    try {
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url())
        let data: unknown
        let workspaceId: string | undefined
        if (url.pathname.endsWith('/v1/auth/mcp-token')) {
          data = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 300 }
        } else if (url.pathname.endsWith('/mcp')) {
          const request = route.request().postDataJSON() as { method?: string; params?: Record<string, unknown> }
          const method = request.method ?? ''
          const params = request.params ?? {}
          workspaceId = route.request().headers()['x-workspace-id']
          calls.push({ method, params, workspaceId })
          if (method === 'ops.session') data = {
            workspace_id: workspaceId, workbench: 'workspace',
            capabilities: ['workspace.member.read', 'workspace.member.manage'],
            assignable_roles: ['operator', 'finance'],
          }
          else if (method === 'ops.members.list') data = {
            items: members.map(member => ({ ...member })), total: members.length,
            offset: Number(params.offset ?? 0), limit: Number(params.limit ?? 20), hasMore: false,
          }
          else if (method === 'ops.member.upsert') {
            const subject = String(params.external_subject)
            const existing = members.find(member => member.externalSubject === subject)
            if (existing) {
              existing.role = String(params.role)
              existing.status = String(params.status ?? existing.status)
              existing.revision += 1
            } else {
              members.push({ id: 'member_invited', externalSubject: subject, displayName: String(params.display_name ?? ''), role: String(params.role), status: String(params.status), revision: 1, governance: { canChangeTarget: true, canDeactivateTarget: true } })
            }
            data = { updated: true }
          }
          else if (method === 'ops.member.suspend') {
            const existing = members.find(member => member.externalSubject === String(params.external_subject))
            if (!existing) throw new Error('Cannot suspend missing fixture member')
            existing.status = 'suspended'
            existing.revision += 1
            data = { updated: true }
          }
          else throw new Error(`Unexpected MCP method: ${method}`)
          data = { result: data }
        } else return route.continue()
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ request_id: 'members-fixture-request', trace_id: 'members-fixture-trace', workspace_id: workspaceId ?? '', data, warnings: [], next_actions: [], error: null }) })
      })

      await page.goto(`${baseUrl}/__merchant-members-mutations-test`, { waitUntil: 'commit' })
      await page.getByText('现有成员').waitFor()

      await page.getByLabel('成员登录账号').fill('invitee@example.test')
      await page.getByLabel('显示名').fill('新邀请成员')
      await page.getByRole('form', { name: '邀请工作区成员' }).getByLabel('角色').selectOption('finance')
      await page.getByLabel('邀请原因').fill('负责月度账务核对')
      await page.getByRole('button', { name: '邀请成员', exact: true }).click()
      await page.getByText('新邀请成员').waitFor()
      await page.getByText('待接受').waitFor()
      expect(calls.find(call => call.method === 'ops.member.upsert')).toMatchObject({
        workspaceId: 'ws_members_fixture',
        params: { external_subject: 'invitee@example.test', display_name: '新邀请成员', role: 'finance', status: 'invited', reason: '负责月度账务核对' },
      })

      await page.getByRole('button', { name: '调整 新邀请成员 的角色' }).click()
      await page.getByLabel('新角色').selectOption('operator')
      await page.getByLabel('操作原因').fill('改由日常运营负责')
      await page.getByRole('button', { name: '确认改角色' }).click()
      await page.getByText('成员角色已更新。').waitFor()
      await page.getByRole('row', { name: /新邀请成员/ }).getByText('运营').waitFor()

      await page.getByRole('button', { name: '停用 新邀请成员' }).click()
      await page.getByLabel('操作原因').fill('成员已离开运营团队')
      await page.getByRole('button', { name: '确认停用' }).click()
      await page.getByText('成员已停用。').waitFor()
      await page.getByRole('row', { name: /新邀请成员/ }).getByText('已停用').waitFor()

      expect(calls.filter(call => call.method === 'ops.members.list')).toHaveLength(4)
      expect(calls.find(call => call.method === 'ops.member.suspend')).toMatchObject({
        workspaceId: 'ws_members_fixture',
        params: { external_subject: 'invitee@example.test', expected_revision: '2', reason: '成员已离开运营团队' },
      })
      expect(pageErrors).toEqual([])
    } finally { await page.close() }
  }, 45_000)
})
