import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

// Mounts the real page and its authorization/workspace gates in desktop Chromium.
// Only /api/mcp is mocked; this is UI/RPC-dispatch evidence, not API/RLS evidence.
describe("customer delivery authorization and workspace isolation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  const entryPath = "/__customer-delivery-authz-entry.tsx";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-authz-"));
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
        name: "customer-delivery-authz-regression",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { CustomerDeliveryPage } from '/src/pages/CustomerDeliveryPage.tsx';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            function Harness() {
              const query = new URLSearchParams(location.search);
              const [workspace, setWorkspace] = useState(query.get('target') ?? '');
              const read = query.get('read') !== 'false';
              const write = query.get('write') === 'true';
              const model = {
                authorization: { can: capability => capability === 'customer.delivery.read' ? read : capability === 'customer.delivery.update' ? write : capability === 'workspace.directory.read' },
                authorizationTargetWorkspaceId: workspace,
                setAuthorizationTargetWorkspaceId: setWorkspace,
                loadWorkspaceDirectory: async () => {},
                workspaceDirectoryLoading: false,
                workspaceRows: [
                  { workspaceId: 'ws-tenant-a', enterpriseName: '隔离测试企业A', status: 'active' },
                  { workspaceId: 'ws-tenant-b', enterpriseName: '隔离测试企业B', status: 'active' },
                ],
              };
              return React.createElement(App, null, React.createElement(CustomerDeliveryPage, { model }));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__customer-delivery-authz-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Customer delivery authz listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 20_000);

  async function openPage(query: string) {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const calls: Array<{ method: string; params: Record<string, string> }> = [];
    await page.route(`${baseUrl}/api/mcp`, async route => {
      const request = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
      calls.push({ method: request.method, params: request.params });
      let result: unknown;
      if (request.method === "ops.customer-delivery.list") {
        const tenant = request.params.target_workspace_id;
        const companyName = tenant === "ws-tenant-a" ? "租户A客户" : "租户B客户";
        result = { items: [{ id: `delivery-${tenant}`, companyName, paymentStatus: "paid", profile: true, integration: true, acceptance: true, training: false, revision: 1, videos: [] }], total: 1, offset: 0, limit: 20, hasMore: false, project_owner_options: [], support_owner_options: [] };
      } else {
        result = { items: [] };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
    });
    await page.goto(`${baseUrl}/__customer-delivery-authz-test${query}`);
    return { page, calls };
  }

  it("dispatches no customer-delivery reads or writes without read permission", async () => {
    const { page, calls } = await openPage("?read=false&write=true&target=ws-tenant-a");
    try {
      await page.getByText("当前会话没有客户交付读取权限", { exact: true }).waitFor();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(calls).toEqual([]);
    } finally { await page.close(); }
  });

  it("dispatches no tenant RPC when read/write permission exists but no workspace was selected", async () => {
    const { page, calls } = await openPage("?read=true&write=true");
    try {
      await page.getByText("尚未选择客户工作区", { exact: true }).waitFor();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(calls).toEqual([]);
      expect(await page.getByRole("button", { name: "刷新交付档案", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "新建客户", exact: true }).isDisabled()).toBe(true);
    } finally { await page.close(); }
  });

  it("clears tenant A rows on workspace change and only renders tenant B data", async () => {
    const { page, calls } = await openPage("?read=true&write=true");
    try {
      const workspace = page.getByRole("combobox", { name: "客户交付目标企业工作区", exact: true });
      await workspace.click();
      await page.locator(".ant-select-item-option-content").filter({ hasText: "隔离测试企业A · ws-tenant-a" }).click();
      await page.getByRole("cell", { name: "租户A客户", exact: true }).waitFor();
      expect(calls.some(call => call.method === "ops.customer-delivery.list" && call.params.target_workspace_id === "ws-tenant-a")).toBe(true);

      await workspace.click();
      await page.locator(".ant-select-item-option-content").filter({ hasText: "隔离测试企业B · ws-tenant-b" }).click();
      await page.getByRole("cell", { name: "租户B客户", exact: true }).waitFor();
      expect(await page.getByRole("cell", { name: "租户A客户", exact: true }).count()).toBe(0);
      expect(calls.some(call => call.method === "ops.customer-delivery.list" && call.params.target_workspace_id === "ws-tenant-b")).toBe(true);
      expect(calls.filter(call => call.method === "ops.customer-delivery.list").every(call => ["ws-tenant-a", "ws-tenant-b"].includes(call.params.target_workspace_id))).toBe(true);
    } finally { await page.close(); }
  }, 45_000);
});
