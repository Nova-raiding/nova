import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

describe("PlatformManualProductImport interactive workflow", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(`${tmpdir()}/ops-manual-product-import-`);
    const entryPath = "/__manual-product-import-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../../"),
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("password"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("production"),
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "manual-product-import-interaction-harness",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { PlatformManualProductImport } from '/src/components/stores/PlatformManualProductImport.tsx';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            const workspaces = [{ workspaceId: 'ws_demo', enterpriseName: '贵人鸟', status: 'active', planName: 'demo', monthlyPriceCny: 0, usedTasks: 0, includedTasks: 0, subscriptionStatus: 'active', memberCount: 1 }];
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(PlatformManualProductImport, { workspaces })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__manual-product-import-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Manual product import test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 90_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("scopes the preview to the selected workspace/store and requires confirmation before recording the import receipt", async () => {
    const page: Page = await browser!.newPage({ viewport: { width: 1440, height: 1000 } });
    const rpcRequests: Array<{ method: string; params: Record<string, string> }> = [];
    page.on("pageerror", error => { throw error; });
    await page.route(`${baseUrl}/api/mcp`, async route => {
      const request = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
      rpcRequests.push({ method: request.method, params: request.params });
      if (request.method === "ops.platform.manual-stores.list") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: { items: [{ platform: "jd", account_id: "store_demo", store_alias: "贵人鸟官方旗舰店" }] },
        }) });
      }
      if (request.method === "ops.platform.product.import.batch") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: { result: { count: 1, products: [{ id: "product-demo-1" }] } },
        }) });
      }
      return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({
        jsonrpc: "2.0", id: request.id, error: { code: "FORBIDDEN", message: `Unexpected RPC: ${request.method}` },
      }) });
    });

    try {
      await page.goto(`${baseUrl}/__manual-product-import-test`);
      page.setDefaultTimeout(10_000);

      const selectors = page.getByRole("combobox");
      await selectors.nth(0).click();
      await selectors.nth(0).press("ArrowDown");
      await selectors.nth(0).press("Enter");
      await expect.poll(() => rpcRequests.some(request => request.method === "ops.platform.manual-stores.list")).toBe(true);
      await selectors.nth(1).click();
      await selectors.nth(1).press("ArrowDown");
      await selectors.nth(1).press("Enter");
      await expectText(page, "仅显示当前所选商家工作区的人工登记店铺。");

      await page.locator('input[type="file"]').setInputFiles({
        name: "merchant-products.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("平台,店铺账号,商品货号,商品名称,价格,库存\n京东,,QA-001,测试运动鞋,199,3\n", "utf8"),
      });
      await expectText(page, "预览：1 个商品");
      await expectText(page, "表格缺少平台或店铺账号");
      await page.getByPlaceholder("资料来源，例如商家提供的文件编号或公开链接").fill("商家提供文件 #QA-001");
      await page.getByPlaceholder("填写本次代商家上传的原因").fill("按商家要求录入并待商家核验");
      const confirm = page.getByRole("button", { name: "确认预览并导入所选商家店铺" });
      await confirm.waitFor();
      expect(await confirm.isDisabled()).toBe(true);
      expect(rpcRequests.filter(request => request.method === "ops.platform.product.import.batch")).toHaveLength(0);

      await page.getByRole("checkbox", { name: "我已核对原始资料，确认这些商品属于所选店铺" }).check();
      await confirm.click();
      await expectText(page, "已导入 1 个商品到所选商家店铺，商品事实待商家核对。");

      const storeLookup = rpcRequests.find(request => request.method === "ops.platform.manual-stores.list");
      expect(storeLookup?.params).toMatchObject({ workspace_id: "ws_demo" });
      const importRequest = rpcRequests.find(request => request.method === "ops.platform.product.import.batch");
      expect(importRequest?.params).toMatchObject({
        workspace_id: "ws_demo",
        platform: "jd",
        account_id: "store_demo",
        source_ref: "商家提供文件 #QA-001",
        reason: "按商家要求录入并待商家核验",
        store_assignment_confirmed: "true",
      });
      expect(JSON.parse(importRequest!.params.products_json)).toMatchObject([
        { platform: "jd", account_id: "store_demo", local_product_key: "QA-001", title: "测试运动鞋", price: 199, stock: 3 },
      ]);
      expect(importRequest!.params.source_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(rpcRequests.filter(request => request.method === "ops.platform.product.import.batch")).toHaveLength(1);
    } finally { await page.close(); }
  }, 60_000);
});

async function expectText(page: Page, text: string) {
  await page.getByText(text, { exact: false }).first().waitFor();
}
