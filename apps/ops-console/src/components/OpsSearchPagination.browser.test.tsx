import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

declare global {
  interface Window {
    __directoryCalls?: Array<{ query: string; page: number; pageSize: number }>;
    __auditListCalls?: string[];
    __auditExports?: number;
    __auditDownloads?: number;
    __releaseAuditFilter?: () => void;
    __releaseAuditActorB?: () => void;
    __releaseAuditActorC?: () => void;
    __releaseAuditExport?: () => void;
  }
}

describe("Ops search and pagination pending states", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-search-pagination-"));
    const entryPath = "/__ops-search-pagination-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "ops-search-pagination-regressions",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { PlatformSupportWorkspace } from '/src/components/support/PlatformSupportWorkspace.tsx';
            import { AuditCenterSection } from '/src/components/audit/AuditCenterSection.tsx';
            import { useAuditCenter } from '/src/hooks/useAuditCenter.ts';
            window.__directoryCalls = [];
            window.__auditListCalls = [];
            window.__auditExports = 0;
            window.__auditDownloads = 0;
            HTMLAnchorElement.prototype.click = function() { window.__auditDownloads++; };
            const auditRow = (id, actorId, action) => ({id,source:'operation',workspaceId:'ws-a',actorId,action,resourceType:'task',resourceId:'t-'+id,occurredAt:'2026-09-01T00:00:00Z',reason:'',redacted:true});
            const auditClient = {
              list: query => {
                const actor = query.actorId || 'actor-a';
                window.__auditListCalls.push(actor);
                if (actor === 'actor-b' || actor === 'actor-c') return new Promise(resolve => {
                  const release = () => resolve({ records: [auditRow(actor, actor, actor+'-filter-result')], totalRecords:1 });
                  if (actor === 'actor-b') { window.__releaseAuditActorB = release; window.__releaseAuditFilter = release; }
                  else window.__releaseAuditActorC = release;
                });
                return Promise.resolve({ records: [auditRow('old', 'actor-a', 'old-filter-result')], totalRecords:1 });
              },
              listPlatform: async () => ({records:[],totalRecords:0}),
              detail: async () => ({}),
              exportCsv: async () => { window.__auditExports++; return await new Promise(resolve => { window.__releaseAuditExport = () => resolve({csv:'stale',contentType:'text/csv',fileName:'audit.csv'}); }); },
            };
            function Harness() {
              const [directory, setDirectory] = useState({ items: [], offset: 0, limit: 20, hasMore: false });
              const [directoryLoading, setDirectoryLoading] = useState(false);
              const model = {
                authorization: { can: capability => ['support.ticket.read', 'workspace.directory.read'].includes(capability) },
                opsSession: { actor_id: 'support-agent' },
                workspaceDirectory: directory, workspaceDirectoryLoading: directoryLoading,
                workspaceDirectoryError: '',
                loadWorkspaceDirectory: async ({query, page, pageSize}) => {
                  window.__directoryCalls.push({query, page, pageSize});
                  setDirectoryLoading(true);
                  return new Promise(resolve => setTimeout(() => {
                    setDirectory({ items: [{workspaceId: query || 'ws-any', enterpriseName: query || '任意企业', status: 'active'}], offset: (page - 1) * pageSize, limit: pageSize, hasMore: page < 4 });
                    setDirectoryLoading(false);
                    resolve(true);
                  }, 120));
                },
              };
              const audit = useAuditCenter(auditClient, 'ws-a', true, false);
              return React.createElement(App, null,
                React.createElement(React.Fragment, null,
                  React.createElement(PlatformSupportWorkspace, { model }),
                  React.createElement(AuditCenterSection, { controller:audit, canExport:true })
                )
              );
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__ops-search-pagination-test") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(output);
            }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Ops regression listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  const open = async () => {
    if (!browser) throw new Error("Browser did not start");
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(60_000);
    await page.goto(`${baseUrl}/__ops-search-pagination-test`, { waitUntil: "commit", timeout: 60_000 });
    await page.getByText("不可变审计记录").waitFor();
    return page;
  };

  it("resets support-directory pagination when a new search is submitted", async () => {
    const page = await open();
    try {
      const search = page.locator(".ant-input").first();
      await search.fill("Alpha");
      await page.getByRole("button", { name: "读取授权企业目录" }).click();
      await page.getByRole("button", { name: "下一页企业" }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "下一页企业" }).click();
      await page.waitForFunction(() => window.__directoryCalls?.length === 2);
      await search.fill("Beta");
      expect(await page.getByRole("button", { name: "下一页企业" }).isDisabled()).toBe(true);
      await page.getByRole("button", { name: "读取授权企业目录" }).click();
      await page.waitForFunction(() => window.__directoryCalls?.length === 3);
      const calls = await page.evaluate(() => window.__directoryCalls);
      expect(calls).toEqual([
        { query: "Alpha", page: 1, pageSize: 20 },
        { query: "Alpha", page: 2, pageSize: 20 },
        { query: "Beta", page: 1, pageSize: 20 },
      ]);
    } finally { await page.close(); }
  }, 30_000);

  it("hides old audit rows and blocks export until the changed filter resolves", async () => {
    const page: Page = await open();
    try {
      await page.getByText("old-filter-result").waitFor();
      await page.getByRole("textbox", { name: "按操作者筛选" }).fill("actor-b");
      await page.getByText("正在加载审计记录").waitFor();
      expect(await page.getByText("old-filter-result").count()).toBe(0);
      const exportButton = page.getByRole("button", { name: "导出当前筛选" });
      expect(await exportButton.getAttribute("aria-disabled")).toBe("true");
      expect(await exportButton.isDisabled()).toBe(true);
      expect(await page.evaluate(() => window.__auditExports)).toBe(0);
      await page.waitForFunction(() => typeof window.__releaseAuditFilter === "function");
      await page.evaluate(() => window.__releaseAuditFilter?.());
      await page.getByText("actor-b-filter-result").waitFor();
      await page.waitForFunction(() => document.querySelector('button[aria-describedby="audit-export-help"]')?.getAttribute("aria-disabled") !== "true");
      expect(await exportButton.isDisabled()).toBe(false);
    } finally { await page.close(); }
  }, 30_000);

  it("ignores an old audit list response that arrives after a newer filter", async () => {
    const page = await open();
    try {
      await page.getByText("old-filter-result").waitFor();
      const actor = page.getByRole("textbox", { name: "按操作者筛选" });
      await actor.fill("actor-b");
      await page.waitForFunction(() => window.__releaseAuditActorB !== undefined);
      await actor.fill("actor-c");
      await page.waitForFunction(() => window.__releaseAuditActorC !== undefined);
      await page.evaluate(() => window.__releaseAuditActorC?.());
      await page.getByText("actor-c-filter-result").waitFor();
      await page.evaluate(() => window.__releaseAuditActorB?.());
      await page.waitForTimeout(100);
      expect(await page.getByText("actor-c-filter-result").count()).toBe(1);
      expect(await page.getByText("actor-b-filter-result").count()).toBe(0);
    } finally { await page.close(); }
  }, 30_000);

  it("does not download an export started under filters that have since changed", async () => {
    const page = await open();
    try {
      await page.getByText("old-filter-result").waitFor();
      await page.getByRole("button", { name: "导出当前筛选" }).click();
      await page.waitForFunction(() => window.__releaseAuditExport !== undefined);
      await page.getByRole("textbox", { name: "按操作者筛选" }).fill("actor-b");
      await page.getByText("正在加载审计记录").waitFor();
      await page.evaluate(() => window.__releaseAuditExport?.());
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.__auditExports)).toBe(1);
      expect(await page.evaluate(() => window.__auditDownloads)).toBe(0);
    } finally { await page.close(); }
  }, 30_000);
});
