import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("IncidentsPage list recovery and filters", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-incidents-page-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-incidents-${randomUUID()}`;
    const harnessHtml = join(opsRoot, `${harnessName}.html`);
    const harnessEntry = join(opsRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(harnessEntry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from 'antd';
      import { IncidentsPage } from '/src/pages/IncidentsPage.tsx';
      window.__incidentListCalls = [];
      const incident = { id: 'inc-1', workspaceId: 'ws-a', title: 'API 请求失败', summary: '商家 API 请求持续失败', severity: 'sev2', status: 'investigating', affectedComponents: ['api'], affectedWorkspaceIds: ['ws-a'], revision: 1, createdBy: 'ops', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' };
      const client = {
        list: async input => {
          window.__incidentListCalls.push({ status: input.status, severity: input.severity });
          if (window.__incidentListCalls.length === 1) throw new Error('读取事故列表失败');
          return { items: [incident] };
        },
        get: async () => incident,
        timeline: async () => ({ items: [] }),
        create: async () => { throw new Error('unused'); },
        comment: async () => { throw new Error('unused'); },
        transition: async () => { throw new Error('unused'); },
        assignCommander: async () => { throw new Error('unused'); },
        updateScope: async () => { throw new Error('unused'); },
      };
      const authorization = { scope: { kind: 'platform' }, canAny: () => true };
      createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(IncidentsPage, { client, authorization })));
    `, { flag: "wx" });
    vite = await createServer({
      configFile: false,
      root: opsRoot,
      cacheDir: join(cacheDirectory, ".vite-cache"),
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Incidents page test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally {
        try { await Promise.all(harnessFiles.map(file => rm(file, { force: true }))); }
        finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
      }
    }
  }, 60_000);

  it("keeps initial list failure to one recovery action, then applies and clears filters", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByText("事故列表不可用").waitFor();
      await page.getByText("读取事故列表失败").waitFor();
      expect(await page.getByRole("button", { name: "重试", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "重试事故列表" }).count()).toBe(1);

      await page.getByRole("button", { name: "重试事故列表" }).click();
      await page.getByText("API 请求失败").waitFor();
      const statusFilter = page.getByRole("combobox", { name: "按状态筛选" });
      await statusFilter.focus();
      await statusFilter.press("ArrowDown");
      await statusFilter.press("Enter");
      await page.getByRole("button", { name: "应用筛选" }).click();
      await page.waitForFunction(() => window.__incidentListCalls.length === 3);
      expect(await page.evaluate(() => window.__incidentListCalls[2])).toEqual({ status: "investigating", severity: undefined });

      await page.getByRole("button", { name: "清除筛选" }).click();
      await page.waitForFunction(() => window.__incidentListCalls.length === 4);
      expect(await page.evaluate(() => window.__incidentListCalls[3])).toEqual({ status: undefined, severity: undefined });
    } finally { await page.close(); }
  }, 60_000);
});

declare global {
  interface Window { __incidentListCalls: Array<{ status?: string; severity?: string }> }
}
