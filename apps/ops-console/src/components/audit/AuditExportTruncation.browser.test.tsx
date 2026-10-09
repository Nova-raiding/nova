import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'

declare global {
  interface Window {
    __auditTruncated?: boolean
    __auditDownloads?: number
  }
}

describe('audit export truncation notice', () => {
  let browser: Browser | undefined
  let vite: ViteDevServer | undefined
  let cacheDirectory: string | undefined
  let baseUrl: string

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'audit-export-truncation-'))
    const entryPath = '/__audit-export-truncation-entry.tsx'
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
      cacheDir: cacheDirectory,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: 'audit-export-truncation-regression',
        resolveId(id) { if (id === entryPath) return `\0${entryPath}` },
        load(id) {
          if (id !== `\0${entryPath}`) return
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { AuditCenterSection } from '/src/components/audit/AuditCenterSection.tsx';
            import { useAuditCenter } from '/src/hooks/useAuditCenter.ts';
            window.__auditTruncated = false;
            window.__auditDownloads = 0;
            HTMLAnchorElement.prototype.click = function() { window.__auditDownloads++; };
            const row = {id:'audit-1',source:'operation',workspaceId:'ws-a',actorId:'ops',action:'member.update',resourceType:'member',resourceId:'member-1',occurredAt:'2026-10-01T00:00:00Z',reason:'review',redacted:true};
            const client = {
              list: async () => ({records:[row],totalRecords:1,truncated:false}),
              detail: async () => ({}),
              exportCsv: async () => ({
                exportId:'export-1', fileName:'audit.csv', contentType:'text/csv; charset=utf-8', csv:'source\\r\\noperation',
                rowCount: window.__auditTruncated ? 5000 : 2, truncated: window.__auditTruncated,
              }),
            };
            function Harness() {
              const controller = useAuditCenter(client, 'ws-a', true, false);
              return React.createElement(App, null, React.createElement(AuditCenterSection, {controller, canExport:true}));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/__audit-export-truncation-test') return next()
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
    if (!address || typeof address === 'string') throw new Error('Audit export test listener did not bind')
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

  const open = async (): Promise<Page> => {
    if (!browser) throw new Error('Browser did not start')
    const page = await browser.newPage()
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(60_000)
    await page.goto(`${baseUrl}/__audit-export-truncation-test`, { waitUntil: 'commit', timeout: 60_000 })
    await page.getByText('不可变审计记录').waitFor()
    await page.getByRole('button', { name: '导出当前筛选' }).waitFor()
    return page
  }

  it('warns that a truncated CSV contains only the first 5,000 rows', async () => {
    const page = await open()
    try {
      await page.evaluate(() => { window.__auditTruncated = true })
      await page.getByRole('button', { name: '导出当前筛选' }).click()
      const notice = page.getByRole('status').filter({ hasText: '审计导出已截断' })
      await notice.waitFor()
      expect(await notice.textContent()).toContain('前 5,000 条记录')
      expect(await notice.textContent()).toContain('缩小筛选条件')
      expect(await page.evaluate(() => window.__auditDownloads)).toBe(1)
    } finally { await page.close() }
  }, 30_000)

  it('reports the exported row count when the CSV is complete', async () => {
    const page = await open()
    try {
      await page.getByRole('button', { name: '导出当前筛选' }).click()
      const notice = page.getByRole('status').filter({ hasText: '审计导出完成' })
      await notice.waitFor()
      expect(await notice.textContent()).toContain('已导出 2 条记录')
      expect(await page.evaluate(() => window.__auditDownloads)).toBe(1)
    } finally { await page.close() }
  }, 30_000)
})
