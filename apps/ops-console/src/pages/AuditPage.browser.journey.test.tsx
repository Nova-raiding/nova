import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'

type AuditCall = { method: string; params: Record<string, unknown> }
type AuditRecord = { id: string; source: string; workspaceId: string; actorId: string; action: string; resourceType: string; resourceId: string; occurredAt: string; reason: string; redacted: true }

// The browser traverses the real OpsConsoleController, authorization projection,
// navigation registry, page and MCP client. Session and API responses are
// deterministic fixtures; this is not real-account or demo-environment evidence.
describe('Audit route browser journey', () => {
  let browser: Browser | undefined
  let vite: ViteDevServer | undefined
  let cacheDirectory = ''
  let appRoot = ''
  let baseUrl = ''
  let harnessName = ''
  let harnessFiles: string[] = []

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'ops-audit-controller-'))
    appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    harnessName = `.codex-audit-route-${randomUUID()}`
    const harnessHtml = join(appRoot, `${harnessName}.html`)
    const harnessEntry = join(appRoot, `${harnessName}.tsx`)
    harnessFiles = [harnessHtml, harnessEntry]
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/overview?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: 'wx' })
    await writeFile(harnessEntry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'fixture-token', actorId: 'fixture-operator'}));
      createRoot(document.getElementById('root')).render(React.createElement(OpsConsoleController));
    `, { flag: 'wx' })
    vite = await createServer({
      configFile: false,
      root: appRoot,
      cacheDir: cacheDirectory,
      logLevel: 'error',
      define: {
        'import.meta.env.VITE_API_BASE': JSON.stringify('/api'),
        'import.meta.env.VITE_OPS_LOCAL_SESSION': JSON.stringify('false'),
        'import.meta.env.VITE_OPS_AUTH_MODE': JSON.stringify('local'),
        'import.meta.env.VITE_OPS_BUILD_MODE': JSON.stringify('local'),
      },
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Audit route test listener did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  }, 60_000)

  afterAll(async () => {
    try { await browser?.close() }
    finally {
      try { await vite?.close() }
      finally {
        try { await Promise.all(harnessFiles.map(file => rm(file, { force: true }))) }
        finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }) }
      }
    }
  }, 60_000)

  const open = async (options: { includeWorkspaceDirectory?: boolean; workspaceDirectoryMode?: 'ready' | 'empty' | 'error-once' } = {}) => {
    if (!browser) throw new Error('Browser did not start')
    const includeWorkspaceDirectory = options.includeWorkspaceDirectory ?? true
    const workspaceDirectoryMode = options.workspaceDirectoryMode ?? 'ready'
    const page = await browser.newPage({ timezoneId: 'Asia/Shanghai' })
    page.setDefaultTimeout(15_000)
    page.setDefaultNavigationTimeout(60_000)
    const calls: AuditCall[] = []
    let failNextTenantList = 0
    let failNextExport = 0
    let failWorkspaceDirectory = workspaceDirectoryMode === 'error-once' ? 1 : 0
    const unexpectedRequests: string[] = []
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== new URL(baseUrl).origin) {
        unexpectedRequests.push(url.origin)
        await route.abort()
        return
      }
      if (url.pathname !== '/api/mcp') return route.fallback()
      const request = route.request()
      let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> }
      try { rpc = request.postDataJSON() as typeof rpc }
      catch { await route.fulfill({ status: 400, body: 'malformed fixture RPC' }); return }
      const method = rpc.method ?? ''
      const params = rpc.params ?? {}
      calls.push({ method, params })
      let result: unknown = null
      if (method === 'ops.session') {
        result = {
          actor_id: 'fixture-operator', workspace_id: '', roles: ['platform_ops'], workspace_granted: false,
          workbench: 'platform', scope: { type: 'platform' },
          capabilities: ['platform.summary.read', 'audit.read', 'audit.export', ...(includeWorkspaceDirectory ? ['workspace.directory.read'] : [])],
        }
      } else if (method === 'ops.workspaces.list') {
        if (failWorkspaceDirectory > 0) {
          failWorkspaceDirectory--
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32000, message: 'workspace directory temporarily unavailable' } }) })
          return
        }
        const workspaces = workspaceDirectoryMode === 'empty' ? [] : [{ workspaceId: 'ws-route', enterpriseName: '审计旅程测试企业', status: 'active', planName: 'test', monthlyPriceCny: 0, usedTasks: 0, includedTasks: 0, subscriptionStatus: 'active', memberCount: 1 }]
        result = { items: workspaces, total: workspaces.length, offset: 0, limit: 20, hasMore: false }
      } else if (method === 'ops.audit.platform.list') {
        result = { records: [auditRecord()], totalRecords: 1, truncated: false }
      } else if (method === 'ops.audit.list') {
        if (failNextTenantList > 0) {
          failNextTenantList--
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32000, message: 'audit read temporarily unavailable' } }) })
          return
        }
        result = { records: [auditRecord()], totalRecords: 1, truncated: false }
      } else if (method === 'ops.audit.detail') {
        result = { ...auditRecord(), evidence: { redacted: true, fields: { result: 'ok' }, omittedFields: 1 } }
      } else if (method === 'ops.audit.export') {
        if (failNextExport > 0) {
          failNextExport--
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32000, message: 'audit export temporarily unavailable' } }) })
          return
        }
        result = { exportId: 'export-1', fileName: 'audit.csv', contentType: 'text/csv; charset=utf-8', csv: 'id\naudit-route-1', rowCount: 1, truncated: false }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result }) })
    })
    await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '审计中心' }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '审计中心' }).click()
    await page.getByRole('heading', { name: '审计中心' }).waitFor({ state: 'visible' })
    return {
      page, calls, unexpectedRequests,
      failTenantList: () => { failNextTenantList = 1 },
      failExport: () => { failNextExport = 1 },
    }
  }

  it('navigates through the authorized audit route, selects a workspace, filters, opens redacted detail, and exports CSV', async () => {
    const { page, calls, unexpectedRequests, failExport } = await open()
    try {
      const workspaceSelect = page.getByRole('combobox', { name: '审计目标企业主体' })
      await workspaceSelect.waitFor({ state: 'visible' })
      await workspaceSelect.click()
      await page.getByText('审计旅程测试企业 · ws-route', { exact: true }).click()
      await waitForAuditCall(() => calls.some(call => call.method === 'ops.audit.list' && call.params.workspace_id === 'ws-route'))
      await page.getByText('member.update', { exact: true }).waitFor()
      expect(calls.find(call => call.method === 'ops.audit.list')?.params).toMatchObject({ workspace_id: 'ws-route', limit: '20' })

      await page.getByLabel('搜索审计记录').fill('  member.update  ')
      await page.getByLabel('按操作者筛选').fill('ops-user')
      await page.getByLabel('审计开始时间').fill('2026-10-01T08:00')
      await page.getByLabel('审计结束时间').fill('2026-10-02T08:00')
      await page.getByLabel('按来源筛选').click()
      await page.getByText('运营操作', { exact: true }).last().click()
      await waitForAuditCall(() => {
        const query = calls.filter(call => call.method === 'ops.audit.list').at(-1)?.params
        return query?.text === '  member.update  ' && query.actor_id === 'ops-user' && query.sources_json === '["operation"]'
          && query.from_at === '2026-10-01T00:00:00.000Z' && query.to_at === '2026-10-02T00:00:00.000Z'
      })
      const filteredQuery = calls.filter(call => call.method === 'ops.audit.list').at(-1)?.params
      expect(filteredQuery).toMatchObject({ workspace_id: 'ws-route', text: '  member.update  ', actor_id: 'ops-user', sources_json: '["operation"]', from_at: '2026-10-01T00:00:00.000Z', to_at: '2026-10-02T00:00:00.000Z' })

      const detailButton = page.getByRole('button', { name: '查看审计事件 audit-route-1 详情' })
      await detailButton.focus()
      await detailButton.press('Enter')
      await page.locator('[aria-label="审计证据详情"]').waitFor()
      expect(calls.find(call => call.method === 'ops.audit.detail')?.params).toMatchObject({ workspace_id: 'ws-route', source: 'operation', id: 'audit-route-1' })
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '查看审计事件 audit-route-1 详情')
      await page.getByRole('region', { name: '审计证据详情' }).waitFor({ state: 'hidden' })
      const drawerClose = page.locator('.ant-drawer-close')
      if (await drawerClose.isVisible()) await drawerClose.click()

      failExport()
      await page.getByRole('button', { name: '导出当前筛选' }).click()
      const exportAlert = page.locator('[aria-labelledby="audit-export-error-title"]')
      await exportAlert.waitFor()
      await exportAlert.getByRole('button', { name: '重试导出' }).waitFor({ state: 'visible' })
      expect(calls.filter(call => call.method === 'ops.audit.export')).toHaveLength(1)
      const downloadPromise = page.waitForEvent('download')
      await exportAlert.getByRole('button', { name: '重试导出' }).click()
      expect((await downloadPromise).suggestedFilename()).toBe('audit.csv')
      await page.getByRole('status').filter({ hasText: '审计导出完成' }).waitFor()
      expect(calls.filter(call => call.method === 'ops.audit.export').at(-1)?.params).toMatchObject({ workspace_id: 'ws-route', text: '  member.update  ', actor_id: 'ops-user', sources_json: '["operation"]' })
      expect(unexpectedRequests).toEqual([])
    } finally { await page.close() }
  }, 90_000)

  it('keeps workspace rows visible after a refresh failure, blocks stale export, and recovers on retry', async () => {
    const { page, calls, failTenantList, unexpectedRequests } = await open()
    try {
      await page.getByRole('combobox', { name: '审计目标企业主体' }).click()
      await page.getByText('审计旅程测试企业 · ws-route', { exact: true }).click()
      await waitForAuditCall(() => calls.filter(call => call.method === 'ops.audit.list').some(call => call.params.workspace_id === 'ws-route'))
      await page.getByText('member.update', { exact: true }).waitFor()
      failTenantList()
      await page.getByRole('button', { name: '刷新审计' }).click()
      const alert = page.locator('[aria-labelledby="audit-load-error-title"]')
      await alert.waitFor()
      await alert.locator('button').waitFor({ state: 'visible' })
      await page.getByText('读取失败，以下为上次结果（1 条）').waitFor()
      const exportButton = page.getByRole('button', { name: '导出当前筛选' })
      expect(await exportButton.getAttribute('aria-disabled')).toBe('true')
      expect(await page.getByText('member.update', { exact: true }).count()).toBeGreaterThan(0)
      expect(await exportButton.isDisabled()).toBe(true)
      expect(calls.filter(call => call.method === 'ops.audit.export')).toHaveLength(0)

      await alert.locator('button').click()
      await page.getByRole('alert').getByText('已加载全部 1 条审计记录').waitFor()
      expect(await exportButton.getAttribute('aria-disabled')).toBeNull()
      expect(calls.filter(call => call.method === 'ops.audit.list').length).toBeGreaterThanOrEqual(3)
      const downloadPromise = page.waitForEvent('download')
      await exportButton.click()
      expect((await downloadPromise).suggestedFilename()).toBe('audit.csv')
      expect(calls.filter(call => call.method === 'ops.audit.export')).toHaveLength(1)
      expect(unexpectedRequests).toEqual([])
    } finally { await page.close() }
  }, 90_000)

  it('keeps the unselected platform aggregate view read-only for cross-workspace detail and export', async () => {
    const { page, calls, unexpectedRequests } = await open({ includeWorkspaceDirectory: false })
    try {
      await page.getByText('member.update', { exact: true }).waitFor()
      expect(calls.some(call => call.method === 'ops.audit.platform.list')).toBe(true)
      expect(await page.getByRole('combobox', { name: '审计目标企业主体' }).count()).toBe(0)
      expect(await page.getByRole('button', { name: '导出当前筛选' }).getAttribute('aria-disabled')).toBe('true')
      expect(await page.getByRole('button', { name: '查看审计事件 audit-route-1 详情' }).isDisabled()).toBe(true)
      expect(calls.some(call => call.method === 'ops.audit.export')).toBe(false)
      expect(unexpectedRequests).toEqual([])
    } finally { await page.close() }
  }, 90_000)

  it('keeps the aggregate option visible but disabled when the authorized directory is empty', async () => {
    const { page, calls, unexpectedRequests } = await open({ workspaceDirectoryMode: 'empty' })
    try {
      const workspaceSelect = page.getByRole('combobox', { name: '审计目标企业主体' })
      await workspaceSelect.waitFor({ state: 'visible' })
      expect(await workspaceSelect.isDisabled()).toBe(true)
      await page.getByText('暂无可选择的企业主体；当前仅可查看平台聚合记录。').waitFor()
      await page.getByText('member.update', { exact: true }).waitFor()
      expect(calls.some(call => call.method === 'ops.audit.platform.list')).toBe(true)
      expect(unexpectedRequests).toEqual([])
    } finally { await page.close() }
  }, 90_000)

  it('shows a disabled selector and recovers an unavailable directory through its retry action', async () => {
    const { page, calls, unexpectedRequests } = await open({ workspaceDirectoryMode: 'error-once' })
    try {
      const workspaceSelect = page.getByRole('combobox', { name: '审计目标企业主体' })
      await workspaceSelect.waitFor({ state: 'visible' })
      expect(await workspaceSelect.isDisabled()).toBe(true)
      await page.getByText(/企业主体目录读取失败：部分数据集刷新失败（ops\.workspaces\.list）/).waitFor()
      await page.getByRole('button', { name: '重试读取企业主体' }).click()
      await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="审计目标企业主体"]')?.getAttribute('aria-disabled') !== 'true')
      expect(await workspaceSelect.isDisabled()).toBe(false)
      await workspaceSelect.click()
      await workspaceSelect.press('ArrowDown')
      await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'visible' })
      await page.getByRole('option', { name: '审计旅程测试企业 · ws-route' }).waitFor()
      expect(calls.filter(call => call.method === 'ops.workspaces.list').length).toBeGreaterThanOrEqual(2)
      expect(unexpectedRequests).toEqual([])
    } finally { await page.close() }
  }, 90_000)
})

function auditRecord(): AuditRecord {
  return { id: 'audit-route-1', source: 'operation', workspaceId: 'ws-route', actorId: 'ops-user', action: 'member.update', resourceType: 'member', resourceId: 'member-1', occurredAt: '2026-10-01T00:00:00.000Z', reason: 'reviewed', redacted: true }
}

async function waitForAuditCall(predicate: () => boolean) {
  const deadline = Date.now() + 15_000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  expect(predicate()).toBe(true)
}
