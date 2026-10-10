import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const entryPath = '/__merchant-members-test-entry.tsx'
    vite = await createServer({
      configFile: false,
      envDir: false,
      root,
      cacheDir: cacheDirectory,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
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
    page.on('pageerror', error => runtimeErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(message.text()) })
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
          else throw new Error(`Unexpected MCP method: ${method}`)
          data = { result: data }
        } else return route.continue()
        await new Promise(resolve => setTimeout(resolve, 5))
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ request_id: 'fixture-request', trace_id: 'fixture-trace', workspace_id: workspaceId ?? '', data, warnings: [], next_actions: [], error: null }) })
      })
      await page.goto(`${baseUrl}/__merchant-members-test`, { waitUntil: 'commit' })
      try { await page.getByText('成员 ws_a').waitFor() }
      catch { throw new Error(`Initial workspace member list did not render: ${JSON.stringify({ root: await page.locator('#root').innerHTML(), runtimeErrors })}`) }
      expect(await page.locator('body').innerText()).toContain('共 1 位成员')
      await page.getByLabel('成员登录账号').fill('draft@example.com')
      await page.getByLabel('邀请原因').fill('当前工作区邀请')
      await page.getByRole('button', { name: '切换到 ws_b' }).click()
      await page.getByText('成员 ws_b').waitFor()
      expect(await page.getByLabel('成员登录账号').inputValue()).toBe('')
      expect(await page.getByLabel('邀请原因').inputValue()).toBe('')

      expect(calls).toEqual([
        { method: 'ops.session', workspaceId: 'ws_a' },
        { method: 'ops.members.list', workspaceId: 'ws_a' },
        { method: 'ops.session', workspaceId: 'ws_b' },
        { method: 'ops.members.list', workspaceId: 'ws_b' },
      ])
      expect(runtimeErrors).toEqual([])
    } finally { await page.close() }
  }, 30_000)
})
