import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

declare global {
  interface Window { __financeFilterCalls?: Array<{ text?: string; workspaceIds?: string[]; kinds?: string[]; statuses?: string[] }> }
}

describe("Finance advanced filters", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(joinPath(tmpdir(), "ops-finance-advanced-filter-"));
    const entry = "/__finance-advanced-filter-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "finance-advanced-filter-test",
        resolveId(id) { if (id === entry) return `\0${entry}`; },
        load(id) {
          if (id !== `\0${entry}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { FinanceSearchSection } from '/src/components/finance/FinanceSearchSection.tsx';
            import { useFinanceSearch } from '/src/hooks/useFinanceSearch.ts';
            window.__financeFilterCalls = [];
            const client = {
              search: async query => { window.__financeFilterCalls.push({ text: query.text, workspaceIds: query.workspaceIds, kinds: query.kinds, statuses: query.statuses }); return { records: [], summary: { totalRecords: 0, rechargeOrderCny: 0, subscriptionOrderCny: 0, subscriptionOrderWorkspaceCount: 0, subscriptionOrderBySku: {}, walletNetCny: 0, walletCreditCny: 0, walletDebitCny: 0, usageUnits: 0, providerCostCny: 0, customerChargeCny: 0, byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 } }, snapshotAt: '2026-10-10T00:00:00.000Z', scope: { role: 'platform_ops', workspaceCount: 0 } }; },
              detail: async () => ({}), exportCsv: async () => ({ csv: '', contentType: 'text/csv', fileName: 'finance.csv' }),
            };
            function Harness() {
              const controller = useFinanceSearch(client, { limit: 20 }, true);
              return React.createElement(App, null, React.createElement(FinanceSearchSection, { controller }));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__finance-advanced-filter") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Finance advanced filter listener did not bind");
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

  it("shows the advanced filter controls when the operator expands them", async () => {
    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const errorResponses: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", request => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown failure"}`));
    page.on("response", response => { if (response.status() >= 400) errorResponses.push(`${response.status()} ${response.url()}`); });
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${baseUrl}/__finance-advanced-filter`, { waitUntil: "commit", timeout: 60_000 });
      try {
        await page.waitForFunction(() => window.__financeFilterCalls !== undefined && Boolean(document.querySelector("#root")?.firstElementChild));
      } catch {
        throw new Error(`Finance filter React mount did not become ready: ${JSON.stringify(await collectFinanceBrowserDiagnostics(page, { pageErrors, consoleErrors, failedRequests, errorResponses }))}`);
      }
      const toggle = page.getByRole("button", { name: "高级筛选", exact: true });
      try {
        await toggle.waitFor({ state: "visible" });
      } catch {
        throw new Error(`Finance filter toggle did not become visible after React mount: ${JSON.stringify(await collectFinanceBrowserDiagnostics(page, { pageErrors, consoleErrors, failedRequests, errorResponses }))}`);
      }
      expect(pageErrors).toEqual([]);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      const controls = await toggle.getAttribute("aria-controls");
      expect(controls).toBe("finance-advanced-filters");
      const advanced = page.locator(`#${controls}`);
      expect(await advanced.count()).toBe(1);
      expect(await advanced.isVisible()).toBe(false);
      await toggle.click();
      expect(await page.getByRole("button", { name: "收起筛选", exact: true }).getAttribute("aria-expanded")).toBe("true");
      await advanced.waitFor({ state: "visible" });
      expect(await advanced.locator(".ant-select").count()).toBe(2);
    } finally { await page.close(); }
  }, 60_000);

  it("submits normalized workspace, record type, status, and keyword filters together", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${baseUrl}/__finance-advanced-filter`, { waitUntil: "commit", timeout: 60_000 });
      await page.getByRole("button", { name: "高级筛选", exact: true }).click();
      await page.getByLabel("关键词").fill("  recharge_42  ");
      await page.getByLabel("Workspace ID").fill(" ws-a, ws-b  ");

      const kindSelect = page.locator("#finance-advanced-filters .ant-select").nth(0);
      await kindSelect.click();
      await page.getByText("充值订单", { exact: true }).last().click();
      const statusSelect = page.locator("#finance-advanced-filters .ant-select").nth(1);
      await statusSelect.locator("input").fill("paid");
      await statusSelect.locator("input").press("Enter");
      const submit = page.locator('form[aria-label="财务检索筛选"] button[type="submit"]');
      await submit.waitFor({ state: "visible" });
      expect(await submit.innerText()).toContain("检索");
      const previousCallCount = await page.evaluate(() => window.__financeFilterCalls?.length ?? 0);
      await submit.click();

      await page.waitForFunction(count => (window.__financeFilterCalls?.length ?? 0) > count, previousCallCount);
      expect(await page.evaluate(() => window.__financeFilterCalls?.at(-1))).toEqual({
        text: "recharge_42",
        workspaceIds: ["ws-a", "ws-b"],
        kinds: ["recharge_order"],
        statuses: ["paid"],
      });
    } finally { await page.close(); }
  }, 60_000);
});

function joinPath(...parts: string[]): string { return parts.join("/"); }

async function collectFinanceBrowserDiagnostics(page: import("playwright").Page, errors: {
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: string[];
  errorResponses: string[];
}) {
  return {
    rootHtml: await page.locator("#root").innerHTML().catch(() => "<unavailable>"),
    visibleButtons: await page.getByRole("button").allTextContents().catch(() => []),
    pageErrors: errors.pageErrors,
    consoleErrors: errors.consoleErrors,
    failedRequests: errors.failedRequests,
    errorResponses: errors.errorResponses,
  };
}
