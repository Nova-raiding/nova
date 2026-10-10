import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type BindRequest = { method: string; params: Record<string, string>; workspaceHeader?: string; workbenchHeader?: string };

describe("StoresPage brand-store binding browser flow", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(resolve(tmpdir(), "ops-brand-store-binding-"));
    const entryPath = "/__brand-store-binding-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
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
        name: "stores-page-brand-binding-test-entry",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { StoresPage } from '/src/pages/StoresPage.tsx';

            const store = { platform: 'jd', accountId: 'jd:store-unbound', label: '待读授权店铺', state: 'connected', dataMode: 'official_api', readable: true, writeEnabled: false, revision: 3 };
            const revokedStore = { platform: 'tmall', accountId: 'tmall-revoked', label: '已撤销店铺', state: 'revoked', dataMode: 'official_api', readable: false, writeEnabled: false, revision: 2 };
            const initialBrand = { id: 'brand-scope-1', title: '隔离品牌', revision: 7, platforms: [] };
            const boundBrand = { ...initialBrand, platforms: [{ id: 'brand-scope-1:jd', platform: 'jd', title: '京东', stores: [{ id: 'bound-jd-store', accountId: store.accountId }] }] };
            window.__brandBindingState = { calls: [], loads: 0 };

            function Harness() {
              const [brands, setBrands] = useState([initialBrand]);
              const model = {
                authorization: {
                  scope: { kind: 'workspace', id: 'ws-brand-scope' },
                  roles: ['workspace_owner'],
                  can: capability => ['customer.content.read', 'customer.content.update'].includes(capability),
                  scopeFor: () => ({ kind: 'workspace', id: 'ws-brand-scope' }),
                },
                dataSetError: () => undefined,
                loading: false,
                storeDirectory: [store, revokedStore],
                brandNavigation: brands,
                platformBrandUnitSummary: undefined,
                canPlatformOps: true,
                automationPolicies: [], automationPolicy: undefined, automationScan: undefined,
                automationScope: '', selectedAutomationStore: undefined, canQueue: false,
                workspaceDirectory: { items: [{ workspaceId: 'ws-brand-scope', enterpriseName: '隔离工作区', status: 'active' }] },
                load: async () => {
                  window.__brandBindingState.loads += 1;
                  setBrands([boundBrand]);
                },
                saveStoreAlias: async () => true, revokeStore: async () => undefined,
                setAutomationPolicy: () => {}, updateAutomationSync: async () => undefined,
                loadAutomationScope: async () => undefined, scanAutomation: async () => undefined,
                updateAutomation: async () => undefined,
              };
              return React.createElement(App, null, React.createElement(StoresPage, { model, onNavigate: () => {} }));
            }

            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: 'ws-brand-scope', actorId: 'owner-fixture', token: 'fixture-token', workbench: 'workspace' }));
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__brand-store-binding") return next();
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
    if (!address || typeof address === "string") throw new Error("Brand binding fixture did not bind");
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

  it("sends workspace-scoped bind parameters and refreshes the brand tree after success", async () => {
    const page = await openPage();
    const requests: BindRequest[] = [];
    await page.route(`${baseUrl}/api/mcp`, async route => {
      const request = route.request();
      const body = request.postDataJSON() as { id: string; method: string; params: Record<string, string> };
      requests.push({
        method: body.method,
        params: body.params,
        workspaceHeader: request.headers()["x-workspace-id"],
        workbenchHeader: request.headers()["x-ops-workbench"],
      });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { bound: true } }) });
    });

    try {
      await chooseUnboundStore(page);
      await page.getByRole("button", { name: "绑定店铺", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__brandBindingState.loads)).toBe(1);
      expect(requests).toEqual([{
        method: "brand-unit.bind-store",
        params: { brand_id: "brand-scope-1", platform: "jd", account_id: "jd:store-unbound", expected_revision: "7", reason: "运营台绑定品牌与已授权平台店铺" },
        workspaceHeader: "ws-brand-scope",
        workbenchHeader: "workspace",
      }]);

      await page.getByLabel("隔离品牌待绑定店铺").click();
      await expect.poll(async () => page.getByText("待读授权店铺（jd:store-unbound）", { exact: true }).count()).toBe(0);
      expect(await page.getByText("jd:store-unbound", { exact: true }).count()).toBeGreaterThan(0);
    } finally { await page.close(); }
  }, 45_000);

  it("registers a credential-free store through the page RPC with the chosen workspace scope", async () => {
    const page = await openPage();
    const requests: BindRequest[] = [];
    await page.route(`${baseUrl}/api/mcp`, async route => {
      const request = route.request();
      const body = request.postDataJSON() as { id: string; method: string; params: Record<string, string> };
      requests.push({
        method: body.method,
        params: body.params,
        workspaceHeader: request.headers()["x-workspace-id"],
        workbenchHeader: request.headers()["x-ops-workbench"],
      });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({
        jsonrpc: "2.0", id: body.id, result: {
          connection: { mode: "manual_store_record", token_state: "manually_registered", credential_free: true, authorization_receipt: null },
          applies_to_store_boundary: true,
        },
      }) });
    });

    try {
      await page.getByRole("button", { name: "登记人工店铺", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "登记人工店铺" });
      await dialog.locator("#manual-store-workspace").click();
      await page.getByText("隔离工作区 · ws-brand-scope", { exact: true }).click();
      await dialog.locator("#manual-store-platform").click();
      await page.getByText("淘宝", { exact: true }).last().click();
      await dialog.getByLabel("平台店铺账号 ID", { exact: true }).fill("manual-store-route");
      await dialog.getByLabel("登记理由", { exact: true }).fill("验证运营台实际登记路由");
      await dialog.getByRole("button", { name: "确认登记", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "人工店铺已登记" }).waitFor();
      expect(requests).toEqual([{
        method: "ops.platform.store.record.create",
        params: { workspace_id: "ws-brand-scope", platform: "taobao", account_id: "manual-store-route", reason: "验证运营台实际登记路由" },
        workspaceHeader: "ws-brand-scope",
        workbenchHeader: "workspace",
      }]);
    } finally { await page.close(); }
  }, 45_000);

  it("keeps the selected store and reports a revision conflict without claiming success", async () => {
    const page = await openPage();
    let calls = 0;
    await page.route(`${baseUrl}/api/mcp`, async route => {
      const body = route.request().postDataJSON() as { id: string; method: string };
      calls += 1;
      expect(body.method).toBe("brand-unit.bind-store");
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: "REVISION_CONFLICT", message: "brand revision conflict" } }),
      });
    });

    try {
      await chooseUnboundStore(page);
      await page.getByRole("button", { name: "绑定店铺", exact: true }).click();
      const brandSection = page.locator(".brand-tree-card");
      await brandSection.getByRole("alert").getByText("brand revision conflict", { exact: true }).waitFor();
      const selectedStore = brandSection.getByText("待读授权店铺（jd:store-unbound）", { exact: true });
      expect(await selectedStore.count()).toBe(1);
      expect(await selectedStore.isVisible()).toBe(true);
      expect(await page.evaluate(() => (window as any).__brandBindingState.loads)).toBe(0);
      expect(calls).toBe(1);
    } finally { await page.close(); }
  }, 45_000);

  async function openPage(): Promise<Page> {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/__brand-store-binding`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByText("隔离品牌", { exact: true }).waitFor();
    return page;
  }
});

async function chooseUnboundStore(page: Page) {
  const select = page.getByLabel("隔离品牌待绑定店铺");
  await select.click();
      await page.getByText("待读授权店铺（jd:store-unbound）", { exact: true }).waitFor();
  expect(await page.getByText("已撤销店铺（tmall-revoked）", { exact: true }).count()).toBe(0);
      await page.getByText("待读授权店铺（jd:store-unbound）", { exact: true }).click();
}

declare global {
  interface Window { __brandBindingState: { calls: unknown[]; loads: number } }
}
