import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("assisted purchase stops at the verified pending-payment order", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-assisted-purchase-"));
    const entryPath = "/__assisted-purchase-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      plugins: [{
        name: "assisted-purchase-test",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { AssistedPurchaseOperationsPanel } from '/src/components/commercial/CommercialOperationsWorkspace.tsx';
            window.__assistedPurchaseCalls = [];
            const workspace = 'ws_commercial_browser';
            const catalog = { status: 'ready', data: { items: [
              { id: 'onboarding-v3', skuCode: 'onboarding_once', name: '系统接入服务', type: 'onboarding', visibility: 'public', version: '3', priceLabel: '¥500.00', priceFen: 50000, cycleLabel: '一次性', benefitsSummary: '8小时首响', approvalState: 'approved', executable: true, currentSaleState: 'on_sale', currentSaleVersionId: 'onboarding-v3', validFrom: null, validTo: null, unresolved: [] },
              { id: 'growth-v7', skuCode: 'growth', name: '成长版', type: 'monthly', visibility: 'public', version: '7', priceLabel: '¥2,000.00', priceFen: 200000, cycleLabel: '每月', benefitsSummary: '5,000创意点', approvalState: 'approved', executable: true, currentSaleState: 'on_sale', currentSaleVersionId: 'growth-v7', validFrom: null, validTo: null, unresolved: [] },
            ] } };
            const preview = { workspaceId: workspace, amountFen: 250000, previewHash: 'server-preview-hash', expiresAt: '2099-01-01T00:00:00.000Z', reason: '客户书面授权 REF-2048', onboardingQualified: false, current: null, future: [], lines: [
              { kind: 'onboarding_once', skuCode: 'onboarding_once', name: '系统接入服务', versionId: 'onboarding-v3', amountFen: 50000, cycle: { unit: 'once' }, benefits: [{ name: '首响保障', quantity: 8 }], dependsOn: null },
              { kind: 'purchase', skuCode: 'growth', name: '成长版', versionId: 'growth-v7', amountFen: 200000, cycle: { unit: 'month', count: 1 }, benefits: [{ name: '创意点', quantity: 5000 }], dependsOn: 'onboarding_once' },
            ] };
            const controller = {
              targetWorkspaceId: workspace,
              permissions: { canSearchCustomers: true, canReadOrders: true, canCreateOrder: true },
              data: { catalog },
              client: {
                searchPurchaseCustomers: async query => { window.__assistedPurchaseCalls.push({ method: 'customer.search', query }); return [{ workspaceId: workspace, memberId: 'member-2048', customerId: 'customer-2048', name: '李女士', enterpriseName: '青禾商贸', status: 'active', workspaceStatus: 'active' }]; },
                previewAssistedCheckout: async input => { window.__assistedPurchaseCalls.push({ method: 'checkout.preview', input }); return preview; },
                createAssistedCheckout: async input => { window.__assistedPurchaseCalls.push({ method: 'checkout.create', input }); return { checkout_id: 'checkout-2048', orders: [{ order_id: 'order-opening-2048', workspace_id: workspace, status: 'pending' }, { order_id: 'order-growth-2048', workspace_id: workspace, status: 'pending' }] }; },
                createCommercialPaymentRequest: async input => { window.__assistedPurchaseCalls.push({ method: 'payment.create', input }); },
              },
              loadView: async view => { window.__assistedPurchaseCalls.push({ method: 'read.refresh', view }); },
              setTargetWorkspace: () => {},
            };
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(AssistedPurchaseOperationsPanel, { controller })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__assisted-purchase-test") return next();
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
    if (!address || typeof address === "string") throw new Error("Assisted purchase fixture did not bind");
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

  it("checks the customer, enterprise, frozen first-purchase lines, and creates pending orders without payment", async () => {
    const page = await openFixture();
    try {
      await page.getByLabel("查找代购客户").fill("李女士");
      await page.getByRole("button", { name: "查询真实客户" }).click();
      await page.getByLabel("指定客户和企业").click();
      await page.getByText("李女士 · 青禾商贸", { exact: false }).click();

      await page.getByLabel("当前上架代购商品").click();
      await page.getByText("成长版 · ¥2,000.00", { exact: false }).click();
      await page.getByLabel("当前上架开通费用").click();
      await page.getByText("系统接入服务 · ¥500.00", { exact: false }).click();
      await page.getByLabel("代购操作原因").fill("客户书面授权 REF-2048");
      await page.getByRole("button", { name: "读取服务端代购预览" }).click();

      await page.getByText("系统接入服务", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("合计 ¥2500.00；开通费不包含首期费用", { exact: false }).waitFor({ state: "visible" });
      await page.getByText("成长版", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "确认开通费加首期联合代购" }).click();
      const dialog = page.locator(".ant-modal").filter({ has: page.getByText("确认指定客户代购", { exact: true }) });
      await dialog.waitFor({ state: "visible" });
      await expect.poll(async () => dialog.innerText()).toContain("客户、企业与冻结商品");
      await expect.poll(async () => dialog.innerText()).toContain("李女士 / ws_commercial_browser / 开通费及首期两行 / ¥2500.00");
      await expect.poll(async () => dialog.innerText()).toContain("只创建待支付订单；款项到账、合同依赖与实际授予另行核验。");
      await dialog.getByRole("button", { name: "确认执行" }).click();

      await expect.poll(async () => page.getByRole("status").allInnerTexts()).toContain("订单已创建。真实到账、依赖校验和权益授予仍分别核验，建单不代表已开通。");
      const calls = await page.evaluate(() => window.__assistedPurchaseCalls);
      expect(calls).toContainEqual({ method: "checkout.preview", input: { workspace: "ws_commercial_browser", beneficiaryMemberId: "member-2048", onboardingSkuCode: "onboarding_once", subscriptionSkuCode: "growth", reason: "客户书面授权 REF-2048" } });
      const createCall = calls.find(call => call.method === "checkout.create");
      expect(createCall).toMatchObject({ method: "checkout.create", input: { workspace: "ws_commercial_browser", beneficiaryMemberId: "member-2048", onboardingSkuCode: "onboarding_once", subscriptionSkuCode: "growth", reason: "客户书面授权 REF-2048", previewHash: "server-preview-hash" } });
      expect((createCall?.input as { idempotencyKey?: unknown } | undefined)?.idempotencyKey).toEqual(expect.stringMatching(/^ops_checkout_/u));
      expect(calls.filter(call => call.method === "payment.create")).toEqual([]);
      expect(calls).toContainEqual({ method: "read.refresh", view: "orders" });
    } finally { await page.close(); }
  }, 60_000);

  async function openFixture(): Promise<Page> {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    await page.goto(`${baseUrl}/__assisted-purchase-test`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("region", { name: "指定客户代购" }).waitFor();
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }
});

declare global {
  interface Window {
    __assistedPurchaseCalls: Array<{ method: string; [key: string]: unknown }>;
  }
}
