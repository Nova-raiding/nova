import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("customer delivery archive pagination", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-archive-pagination-"));
    const entryPath = "/__delivery-archive-pagination-entry.tsx";
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
        name: "delivery-archive-pagination-regression",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { CustomerDeliveryPage } from '/src/pages/CustomerDeliveryPage.tsx';
            import { UnsavedChangesProvider } from '/src/components/authz/UnsavedChangesContext.tsx';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            function Harness() {
              const model = {
                authorization: { can: capability => ['customer.delivery.read', 'customer.delivery.update', 'workspace.directory.read'].includes(capability) },
                authorizationTargetWorkspaceId: 'ws-regression',
                setAuthorizationTargetWorkspaceId: () => {},
                loadWorkspaceDirectory: async () => {}, workspaceDirectoryLoading: false,
                workspaceRows: [{ workspaceId: 'ws-regression', enterpriseName: '测试企业', status: 'active' }],
              };
              return React.createElement(UnsavedChangesProvider, null,
                React.createElement(App, null, React.createElement(CustomerDeliveryPage, { model })));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__delivery-archive-pagination-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Delivery archive listener did not bind");
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

  it("decrements the total and returns to the last valid page after archiving its only row", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8_000);
    const offsets: number[] = [];
    let archived = false;
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: `delivery-${index + 1}`, companyName: `客户${index + 1}`, paymentStatus: "paid", profile: true, integration: true, acceptance: true, training: true, revision: 1, videos: [],
    }));
    const lastRecord = { id: "delivery-last", companyName: "末页唯一客户", paymentStatus: "paid", profile: true, integration: true, acceptance: true, training: true, revision: 1, videos: [] };
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
        let result: unknown;
        if (request.method === "ops.customer-delivery.list") {
          const offset = Number(request.params.offset);
          offsets.push(offset);
          const total = archived ? 20 : 21;
          result = { items: offset === 20 ? [lastRecord] : firstPage, total, offset, limit: 20, hasMore: offset + 20 < total, project_owner_options: [], support_owner_options: [] };
        } else if (request.method === "ops.customer-delivery.get") result = lastRecord;
        else if (request.method === "ops.customer-delivery.update") { archived = true; result = { ...lastRecord, revision: 2 }; }
        else if (request.method === "ops.customer-delivery.videos.list") result = { items: [] };
        else return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "FORBIDDEN", message: `Unexpected operation: ${request.method}` } }) });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
      });

      await page.goto(`${baseUrl}/__delivery-archive-pagination-test`, { waitUntil: "domcontentloaded" });
      await page.getByText("共 21 条", { exact: true }).waitFor();
      await page.locator(".ant-pagination-item-2").click();
      await page.getByRole("cell", { name: "末页唯一客户", exact: true }).waitFor();
      await page.getByRole("button", { name: "查看详情", exact: true }).click();
      await page.getByRole("button", { name: "停用并删除记录", exact: true }).waitFor();
      await page.getByRole("button", { name: "停用并删除记录", exact: true }).click();
      await page.getByRole("button", { name: "确认停用并删除", exact: true }).click();

      await page.getByText("共 20 条", { exact: true }).waitFor();
      await page.getByRole("cell", { name: "客户1", exact: true }).waitFor();
      expect(offsets).toEqual([0, 20, 0]);
      expect(await page.getByRole("cell", { name: "末页唯一客户", exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  }, 45_000);
});
