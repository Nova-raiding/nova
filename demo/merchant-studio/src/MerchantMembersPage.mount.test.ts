import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'
import { chromium, type Browser } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

describe('MerchantMembersPage workspace loading', () => {
  let browser: Browser | undefined
  let vite: ViteDevServer | undefined
  let cacheDirectory: string | undefined
  let baseUrl = ''

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'merchant-members-mount-'))
    const port = await new Promise<number>((resolvePort, reject) => {
      const probe = createNetServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        if (!address || typeof address === 'string') return reject(new Error('Could not reserve a browser test port'))
        const selectedPort = address.port
        probe.close((error) => error ? reject(error) : resolvePort(selectedPort))
      })
    })
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const entryPath = '/__merchant-members-test-entry.tsx'
    vite = await createServer({
      configFile: false,
      envDir: false,
      root,
      cacheDir: cacheDirectory,
      logLevel: 'error',
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
      plugins: [react(), {
        name: 'merchant-members-test-entry',
        resolveId(id: string) {
          if (id === entryPath) return '\0merchant-members-test-entry'
        },
        load(id: string) {
          if (id === '\0merchant-members-test-entry') return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { MerchantMembersPage } from '/src/MerchantMembersPage.tsx';
            import { activateMerchantWorkspace, configureMerchantWorkspaceScope } from '/src/api.ts';
            configureMerchantWorkspaceScope(['ws_a', 'ws_b'], 'ws_a');
            function Harness() {
              const [workspace, setWorkspace] = useState('ws_a');
              const account = { accountType: 'merchant', workspaceIds: ['ws_a', 'ws_b'] };
              return React.createElement(React.Fragment, null,
                React.createElement('button', { onClick: () => { activateMerchantWorkspace('ws_b'); setWorkspace('ws_b'); } }, '切换到 ws_b'),
                React.createElement('button', { onClick: () => { activateMerchantWorkspace('ws_a'); setWorkspace('ws_a'); } }, '切换到 ws_a'),
                React.createElement(MerchantMembersPage, { baseUrl: '/api', account, activeWorkspaceId: workspace })
              );
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/__merchant-members-test') return next()
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

  it('loads the initial member list and completes a fresh session/list read after workspace switch', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    page.setDefaultTimeout(10_000)
    const runtimeErrors: string[] = []
    const calls: Array<{ method: string; workspaceId: string | undefined }> = []
    let failNextMemberWrite = false
    let heldWorkspace = ''
    let sessionHold = Promise.resolve()
    let releaseSession = () => {}
    const holdSession = (workspaceId: string) => {
      heldWorkspace = workspaceId
      sessionHold = new Promise<void>(resolve => { releaseSession = resolve })
    }
    page.on('pageerror', error => runtimeErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(message.text()) })
    try {
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url())
        let data: unknown
        let workspaceId: string | undefined
        let method = ''
        if (url.pathname.endsWith('/v1/auth/mcp-token')) {
          data = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 300 }
        } else if (url.pathname.endsWith('/mcp')) {
          const request = route.request().postDataJSON() as { method?: string; params?: Record<string, unknown> }
          method = request.method ?? ''
          workspaceId = route.request().headers()['x-workspace-id']
          calls.push({ method, workspaceId })
          if (method === 'ops.session') data = {
            workspace_id: workspaceId, workbench: 'workspace',
            capabilities: ['workspace.member.read', 'workspace.member.manage'],
            assignable_roles: ['operator'],
          }
          else if (method === 'ops.members.list') data = {
            items: [{ id: workspaceId, externalSubject: `${workspaceId}@example.com`, displayName: `成员 ${workspaceId}`, role: 'operator', status: 'active', revision: 1, governance: { canChangeTarget: false, canDeactivateTarget: false } }],
            total: 1, offset: Number(request.params?.offset ?? 0), limit: Number(request.params?.limit ?? 20), hasMore: false,
          }
          else if (method === 'ops.member.upsert') {
            if (failNextMemberWrite) {
              failNextMemberWrite = false
              await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ request_id: 'fixture-request', trace_id: 'fixture-trace', workspace_id: workspaceId ?? '', data: null, warnings: [], next_actions: [], error: { code: 'TEMPORARY_UNAVAILABLE', message: '邀请暂时不可用' } }) })
              return
            }
            data = { id: 'invited-member' }
          }
          else throw new Error(`Unexpected MCP method: ${method}`)
          data = { result: data }
        } else return route.continue()
        if (method === 'ops.session' && workspaceId === heldWorkspace) await sessionHold
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ request_id: 'fixture-request', trace_id: 'fixture-trace', workspace_id: workspaceId ?? '', data, warnings: [], next_actions: [], error: null }) })
      })
      await page.goto(`${baseUrl}/__merchant-members-test`, { waitUntil: 'commit' })
      try { await page.getByText('成员 ws_a').waitFor() }
      catch { throw new Error(`Initial workspace member list did not render: ${JSON.stringify({ root: await page.locator('#root').innerHTML(), runtimeErrors })}`) }
      expect(await page.locator('body').innerText()).toContain('共 1 位成员')
      await page.getByLabel('成员登录账号').fill('draft@example.com')
      await page.getByLabel('邀请原因').fill('当前工作区邀请')
      await page.getByRole('button', { name: '邀请成员' }).click()
      expect(await page.locator('.success-notice').innerText()).toContain('已邀请 draft@example.com')
      holdSession('ws_b')
      await page.getByRole('button', { name: '切换到 ws_b' }).click()
      expect(await page.getByText('成员 ws_a').count()).toBe(0)
      expect(await page.locator('.success-notice').count()).toBe(0)
      await page.getByRole('status').filter({ hasText: '正在切换工作区' }).waitFor({ state: 'visible' })
      releaseSession()
      heldWorkspace = ''
      await page.getByText('成员 ws_b').waitFor()
      expect(await page.getByLabel('成员登录账号').inputValue()).toBe('')
      expect(await page.getByLabel('邀请原因').inputValue()).toBe('')
      failNextMemberWrite = true
      await page.getByLabel('成员登录账号').fill('retry@example.com')
      await page.getByLabel('邀请原因').fill('当前工作区再次邀请')
      await page.getByRole('button', { name: '邀请成员' }).click()
      expect(await page.getByRole('alert').innerText()).toContain('成员操作未确认完成')
      expect(await page.getByLabel('成员登录账号').inputValue()).toBe('retry@example.com')
      holdSession('ws_a')
      await page.getByRole('button', { name: '切换到 ws_a' }).click()
      expect(await page.getByRole('alert').count()).toBe(0)
      expect(await page.locator('.success-notice').count()).toBe(0)
      await page.getByRole('status').filter({ hasText: '正在切换工作区' }).waitFor({ state: 'visible' })
      releaseSession()
      heldWorkspace = ''
      await page.getByText('成员 ws_a').waitFor()

      expect(calls).toEqual([
        { method: 'ops.session', workspaceId: 'ws_a' },
        { method: 'ops.members.list', workspaceId: 'ws_a' },
        { method: 'ops.member.upsert', workspaceId: 'ws_a' },
        { method: 'ops.session', workspaceId: 'ws_a' },
        { method: 'ops.members.list', workspaceId: 'ws_a' },
        { method: 'ops.session', workspaceId: 'ws_b' },
        { method: 'ops.members.list', workspaceId: 'ws_b' },
        { method: 'ops.member.upsert', workspaceId: 'ws_b' },
        { method: 'ops.session', workspaceId: 'ws_a' },
        { method: 'ops.members.list', workspaceId: 'ws_a' },
      ])
      expect(runtimeErrors.filter(error => !error.includes('503 (Service Unavailable)'))).toEqual([])
      expect(runtimeErrors.filter(error => error.includes('503 (Service Unavailable)'))).toHaveLength(1)
    } finally { releaseSession(); await page.close() }
  }, 30_000)
})
