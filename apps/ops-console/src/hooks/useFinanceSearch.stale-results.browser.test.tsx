import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

declare global {
  interface Window {
    __financeSearchCalls?: Array<{ text?: string; signalAborted: boolean }>;
    __financeExports?: number;
    __financeDownloads?: number;
    __financeDetailCalls?: number;
    __failNextFinanceDetail?: boolean;
    __releaseFinanceExport?: () => void;
    __failReplacementSearch?: () => void;
  }
}

describe("finance search stale snapshot protection", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-finance-stale-search-"));
    const entry = "/__finance-stale-search-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "finance-stale-search-test",
        resolveId(id) { if (id === entry) return `\0${entry}`; },
        load(id) {
          if (id !== `\0${entry}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { FinanceSearchSection } from '/src/components/finance/FinanceSearchSection.tsx';
            import { useFinanceSearch } from '/src/hooks/useFinanceSearch.ts';
            const summary = { totalRecords: 1, rechargeOrderCny: 0, subscriptionOrderCny: 0, subscriptionOrderWorkspaceCount: 0, subscriptionOrderBySku: {}, walletNetCny: 0, walletCreditCny: 0, walletDebitCny: 0, usageUnits: 0, providerCostCny: 0, customerChargeCny: 0, byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 } };
            const record = { id: 'old-record', kind: 'wallet_transaction', workspaceId: 'ws-old', status: 'debit', label: '钱包流水', occurredAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z', version: 'v1', redacted: true };
            const client = {
              search: (query, signal) => {
                window.__financeSearchCalls.push({ text: query.text, signalAborted: signal.aborted });
                if (query.text === 'new-filter') return new Promise((_, reject) => {
                  window.__failReplacementSearch = () => reject(new Error('replacement query failed'));
                });
                return Promise.resolve({ records: [record], summary, snapshotAt: '2026-08-29T00:00:00.000Z', scope: { role: 'platform_ops', workspaceCount: 1 } });
              },
              detail: async () => {
                window.__financeDetailCalls++;
                if (window.__failNextFinanceDetail) {
                  window.__failNextFinanceDetail = false;
                  throw new Error('finance detail temporarily unavailable');
                }
                return { ...record, enterpriseName: '演示企业', attributes: {} };
              },
              exportCsv: async () => { window.__financeExports++; return await new Promise(resolve => { window.__releaseFinanceExport = () => resolve({ csv: 'id\\nold-record', contentType: 'text/csv', fileName: 'finance.csv' }); }); },
            };
            window.__financeSearchCalls = [];
            window.__financeExports = 0;
            window.__financeDownloads = 0;
            window.__financeDetailCalls = 0;
            window.__failNextFinanceDetail = false;
            HTMLAnchorElement.prototype.click = function() { window.__financeDownloads++; };
            function Harness() {
              const controller = useFinanceSearch(client, { limit: 20 }, false);
              return React.createElement(App, null, React.createElement(React.Fragment, null,
                React.createElement('button', { onClick: () => void controller.search({ text: 'old-filter', workspaceIds: ['ws-old'] }) }, '读取旧筛选'),
                React.createElement('button', { onClick: () => void controller.search({ text: 'new-filter', workspaceIds: ['ws-new'] }) }, '读取新筛选'),
                React.createElement(FinanceSearchSection, { controller, canExport: true })
              ));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__finance-stale-search") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
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
    if (!address || typeof address === "string") throw new Error("Finance stale search listener did not bind");
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

  it("keeps the old snapshot identifiable and blocks its export after a replacement query fails", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${baseUrl}/__finance-stale-search`, { waitUntil: "commit", timeout: 60_000 });
      await page.getByRole("button", { name: "读取旧筛选" }).click();
      await page.getByText("old-record").waitFor();
      await page.getByRole("button", { name: "导出当前筛选" }).click();
      await page.waitForFunction(() => typeof window.__releaseFinanceExport === "function");
      await page.getByRole("button", { name: "读取新筛选" }).click();
      await page.getByText("本次检索尚未完成，以下暂为上次成功快照").waitFor();
      const exportButton = page.getByRole("button", { name: "导出当前筛选" });
      expect(await exportButton.isDisabled()).toBe(true);
      await page.evaluate(() => window.__releaseFinanceExport?.());
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.__financeDownloads)).toBe(0);
      await page.evaluate(() => window.__failReplacementSearch?.());
      await page.getByText("本次检索失败，以下仍是上次成功快照").waitFor();
      await page.getByText("旧检索条件：关键词 old-filter；Workspace ws-old").waitFor();
      expect(await page.getByText("old-record").count()).toBeGreaterThan(0);
      expect(await exportButton.isDisabled()).toBe(true);
      expect(await page.evaluate(() => window.__financeExports)).toBe(1);
      expect(await page.evaluate(() => window.__financeDownloads)).toBe(0);
      expect(await page.evaluate(() => window.__financeSearchCalls?.map(call => call.text))).toEqual(["old-filter", "new-filter"]);
    } finally { await page.close(); }
  }, 60_000);

  it("opens detail by keyboard, recovers a failed read, and restores focus after closing", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${baseUrl}/__finance-stale-search`, { waitUntil: "commit", timeout: 60_000 });
      await page.getByRole("button", { name: "读取旧筛选" }).click();
      await page.getByText("old-record", { exact: true }).waitFor();
      await page.evaluate(() => { window.__failNextFinanceDetail = true; });

      const detailTrigger = page.getByRole("button", { name: "查看 钱包流水 old-record 详情" });
      await detailTrigger.focus();
      await detailTrigger.press("Enter");
      const drawer = page.getByRole("dialog", { name: "财务详情 · 钱包流水", exact: true });
      await drawer.waitFor({ state: "visible" });
      await drawer.getByRole("alert").getByText("finance detail temporarily unavailable", { exact: true }).waitFor();
      await drawer.getByRole("button", { name: "重试财务详情" }).click();
      await drawer.getByText("演示企业", { exact: true }).waitFor();
      expect(await page.evaluate(() => window.__financeDetailCalls)).toBe(2);

      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "查看 钱包流水 old-record 详情");
    } finally { await page.close(); }
  }, 60_000);
});
