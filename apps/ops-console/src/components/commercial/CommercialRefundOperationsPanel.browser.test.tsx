import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("commercial refund request input validation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-commercial-refund-"));
    const entryPath = "/__commercial-refund-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      plugins: [{
        name: "commercial-refund-test",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { CommercialRefundOperationsPanel } from '/src/components/commercial/CommercialOperationsWorkspace.tsx';
            const calls = [];
            window.__commercialRefundCalls = calls;
            const refunds = { status: 'ready', data: { total: 0, items: [] } };
            const controller = {
              targetWorkspaceId: 'ws_fixture',
              refunds,
              refundsLoadingMore: false,
              permissions: { canReconcilePayment: true },
              loadRefunds: async () => refunds.data,
              loadMoreRefunds: async () => undefined,
              client: { requestCommercialRefund: async input => { calls.push(input); return { request_id: input.requestId, state: 'requested' }; } },
            };
            createRoot(document.getElementById('root')).render(React.createElement(App, null,
              React.createElement(CommercialRefundOperationsPanel, { controller })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__commercial-refund-test") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(output);
            }).catch(next);
          });
        },
      }],
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Commercial refund fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("keeps malformed money and point values beside their fields and blocks the request", async () => {
    const page = await openFixture();
    try {
      await fillRequiredRequest(page);
      await page.getByLabel("退款金额（元）").fill("12.345");
      await page.getByLabel("回滚创意点").fill("-1.5");
      const submit = page.getByRole("button", { name: "提交退款申请" });
      expect(await submit.isDisabled()).toBe(true);
      await page.getByText("金额须为正数，最多两位小数").waitFor({ state: "visible" });
      await page.getByText("回滚点数须为不超过安全整数上限的非负整数").waitFor({ state: "visible" });
      expect(await page.getByLabel("退款金额（元）").getAttribute("aria-invalid")).toBe("true");
      expect(await page.getByLabel("回滚创意点").getAttribute("aria-invalid")).toBe("true");
      expect(await page.evaluate(() => window.__commercialRefundCalls)).toEqual([]);
    } finally { await page.close(); }
  }, 45_000);

  it("submits exact fen and a safe nonnegative integer after correction", async () => {
    const page = await openFixture();
    try {
      await fillRequiredRequest(page);
      await page.getByLabel("退款金额（元）").fill("19.99");
      await page.getByLabel("回滚创意点").fill("12");
      await page.getByRole("button", { name: "提交退款申请" }).click();
      await expect.poll(() => page.evaluate(() => window.__commercialRefundCalls)).toEqual([{
        workspace: "ws_fixture", orderId: "order_fixture", requestId: "refund_fixture", kind: "monthly_unused_points",
        amountFen: 1999, pointsToRevoke: 12, reason: "商业化方案：订单退款人工审核", evidenceRef: "agreement_fixture",
      }]);
      await page.getByText("服务端已接受这次操作").waitFor({ state: "visible" });
    } finally { await page.close(); }
  }, 45_000);

  async function openFixture(): Promise<Page> {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    await page.goto(`${baseUrl}/__commercial-refund-test`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "商业订单退款 / 点数回滚" }).waitFor();
    return page;
  }
});

async function fillRequiredRequest(page: Page) {
  await page.getByLabel("退款订单 ID").fill("order_fixture");
  await page.getByLabel("退款请求 ID").fill("refund_fixture");
  await page.getByLabel("退款申请证据引用").fill("agreement_fixture");
}

declare global {
  interface Window { __commercialRefundCalls: unknown[]; }
}
