import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("customer delivery list error pagination state", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-list-total-error-"));
    const entryPath = "/__delivery-list-total-entry.tsx";
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
        name: "delivery-list-total-error-regression",
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
                authorization: { can: capability => capability === 'customer.delivery.read' || capability === 'workspace.directory.read' },
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
            if (!req.url?.startsWith("/__delivery-list-total-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Delivery list total listener did not bind");
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

  it("clears the previous total when a refresh fails", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    let listRequests = 0;
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as { id: string; method: string };
        if (request.method !== "ops.customer-delivery.list") {
          return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Unexpected operation" } }) });
        }
        listRequests++;
        if (listRequests > 1) {
          return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "测试中的列表读取暂时不可用" } }) });
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: { items: [], total: 21, offset: 0, limit: 20, hasMore: true, project_owner_options: [], support_owner_options: [] },
        }) });
      });

      await page.goto(`${baseUrl}/__delivery-list-total-test`, { waitUntil: "domcontentloaded" });
      await page.getByText("共 21 条", { exact: true }).waitFor();
      await page.getByRole("button", { name: "刷新交付档案", exact: true }).click();
      await page.getByText("测试中的列表读取暂时不可用", { exact: false }).waitFor();
      expect(await page.getByText("共 21 条", { exact: true }).count()).toBe(0);
      expect(listRequests).toBe(2);
    } finally { await page.close(); }
  }, 45_000);
});
