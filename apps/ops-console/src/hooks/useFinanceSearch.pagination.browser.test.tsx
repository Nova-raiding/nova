import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

declare global {
  interface Window { __financePageCalls?: Array<{ cursor: string | null; snapshotAt: string | null }> }
}

describe("finance load-more pagination", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-finance-pagination-"));
    const entry = "/__finance-pagination-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "finance-pagination-test",
        resolveId(id) { if (id === entry) return `\0${entry}`; },
        load(id) {
          if (id !== `\0${entry}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { FinanceSearchSection } from '/src/components/finance/FinanceSearchSection.tsx';
            import { useFinanceSearch } from '/src/hooks/useFinanceSearch.ts';
            const summary = { totalRecords: 3, rechargeOrderCny: 0, subscriptionOrderCny: 0, subscriptionOrderWorkspaceCount: 0, subscriptionOrderBySku: {}, walletNetCny: 0, walletCreditCny: 0, walletDebitCny: 0, usageUnits: 0, providerCostCny: 0, customerChargeCny: 0, byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 } };
            const makeRecord = id => ({ id, kind: 'wallet_transaction', workspaceId: 'ws-page', status: 'debit', label: '钱包流水', occurredAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z', version: id, redacted: true });
            const snapshotAt = '2026-08-29T00:00:00.000Z';
            let cursorCalls = 0;
            const client = {
              search: async query => {
                window.__financePageCalls.push({ cursor: query.cursor ?? null, snapshotAt: query.snapshotAt ?? null });
                if (!query.cursor) return { records: [makeRecord('page-1')], summary, snapshotAt, scope: { role: 'platform_ops', workspaceCount: 1 }, nextCursor: 'cursor-1' };
                if (query.cursor === 'cursor-1') return { records: [makeRecord('page-1'), makeRecord('page-2')], summary, snapshotAt, scope: { role: 'platform_ops', workspaceCount: 1 }, nextCursor: 'cursor-2' };
                cursorCalls += 1;
                if (cursorCalls === 1) throw new Error('page temporarily unavailable');
                return { records: [makeRecord('page-3')], summary, snapshotAt, scope: { role: 'platform_ops', workspaceCount: 1 } };
              },
              detail: async () => ({}),
              exportCsv: async () => ({ csv: '', contentType: 'text/csv', fileName: 'finance.csv' }),
            };
            window.__financePageCalls = [];
            function Harness() {
              const controller = useFinanceSearch(client, { limit: 2 }, true);
              return React.createElement(App, null, React.createElement(FinanceSearchSection, { controller }));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__finance-pagination") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Finance pagination listener did not bind");
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

  it("advances with the same snapshot, deduplicates a repeated row, and retries a failed cursor", async () => {
    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${baseUrl}/__finance-pagination`, { waitUntil: "commit", timeout: 60_000 });
      try { await page.getByText("page-1", { exact: true }).waitFor(); }
      catch (cause) {
        const state = await page.evaluate(() => ({
          calls: window.__financePageCalls ?? null,
          body: document.body.innerText.slice(0, 2_000),
          html: (document.querySelector("#root")?.innerHTML ?? "").slice(0, 2_000),
        }));
        throw new Error(`Finance pagination first page did not render. pageErrors=${JSON.stringify(pageErrors)} state=${JSON.stringify(state).slice(0, 6000)}`, { cause });
      }
      const visibleRecordKeys = () => page.locator("tbody tr[data-row-key]").evaluateAll(rows =>
        [...new Set(rows.map(row => row.getAttribute("data-row-key")))].filter((key): key is string => Boolean(key)).sort(),
      );
      await page.getByText(/已展示 1 条，共 3 条匹配记录/).waitFor();
      expect(await visibleRecordKeys()).toEqual(["wallet_transaction:ws-page:page-1"]);

      const loadMore = page.getByRole("button", { name: "加载更多财务记录", exact: true });
      await loadMore.click();
      await page.getByText("page-2", { exact: true }).waitFor();
      await page.getByText(/已展示 2 条，共 3 条匹配记录/).waitFor();
      expect(await visibleRecordKeys()).toEqual([
        "wallet_transaction:ws-page:page-1",
        "wallet_transaction:ws-page:page-2",
      ]);

      await loadMore.click();
      await page.getByRole("alert").getByText("page temporarily unavailable", { exact: true }).waitFor();
      expect(await visibleRecordKeys()).toEqual([
        "wallet_transaction:ws-page:page-1",
        "wallet_transaction:ws-page:page-2",
      ]);
      await loadMore.click();
      await page.getByText("page-3", { exact: true }).waitFor();
      await page.getByText(/已展示 3 条，共 3 条匹配记录/).waitFor();
      expect(await visibleRecordKeys()).toEqual([
        "wallet_transaction:ws-page:page-1",
        "wallet_transaction:ws-page:page-2",
        "wallet_transaction:ws-page:page-3",
      ]);
      expect(await loadMore.count()).toBe(0);
      expect(await page.evaluate(() => window.__financePageCalls)).toEqual([
        { cursor: null, snapshotAt: null },
        { cursor: "cursor-1", snapshotAt: "2026-08-29T00:00:00.000Z" },
        { cursor: "cursor-2", snapshotAt: "2026-08-29T00:00:00.000Z" },
        { cursor: "cursor-2", snapshotAt: "2026-08-29T00:00:00.000Z" },
      ]);
    } finally { await page.close(); }
  }, 60_000);
});
