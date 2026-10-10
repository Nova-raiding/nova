import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("customer delivery archive conflict", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-archive-conflict-"));
    const entryPath = "/__delivery-archive-conflict-entry.tsx";
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
        name: "delivery-archive-conflict-regression",
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
                authorizationTargetWorkspaceId: 'ws-archive-conflict',
                setAuthorizationTargetWorkspaceId: () => {},
                loadWorkspaceDirectory: async () => {}, workspaceDirectoryLoading: false,
                workspaceRows: [{ workspaceId: 'ws-archive-conflict', enterpriseName: '冲突测试企业', status: 'active' }],
              };
              return React.createElement(UnsavedChangesProvider, null,
                React.createElement(App, null, React.createElement(CustomerDeliveryPage, { model })));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__delivery-archive-conflict-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Delivery archive conflict listener did not bind");
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

  it("does not repeat the archive write when another attempt already archived the row", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8_000);
    let archiveWrites = 0;
    let archived = false;
    const workspaceScopedRequests: Array<{ method: string; workspaceId: string | undefined }> = [];
    const activeRecord = {
      id: "delivery-race", companyName: "并发归档客户", paymentStatus: "paid", profile: true,
      integration: true, acceptance: true, training: true, revision: 1, videos: [],
    };
    const archivedRecord = { ...activeRecord, revision: 2, archivedAt: "2026-10-10T00:00:00.000Z" };
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
        if (request.method.startsWith("ops.customer-delivery.")) {
          workspaceScopedRequests.push({ method: request.method, workspaceId: request.params.target_workspace_id });
        }
        let result: unknown;
        if (request.method === "ops.customer-delivery.list") {
          result = {
            items: archived ? [] : [activeRecord], total: archived ? 0 : 1,
            offset: Number(request.params.offset), limit: Number(request.params.limit), hasMore: false,
            project_owner_options: [], support_owner_options: [],
          };
        } else if (request.method === "ops.customer-delivery.update") {
          archiveWrites++;
          // Simulate a competing archive winning at revision 2 before this
          // operator's revision-1 update is accepted.
          archived = true;
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({
            jsonrpc: "2.0", id: request.id,
            error: { code: "REVISION_CONFLICT", message: "revision conflict", retryable: true },
          }) });
        } else if (request.method === "ops.customer-delivery.get") result = archivedRecord;
        else if (request.method === "ops.customer-delivery.videos.list") result = { items: [] };
        else return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "FORBIDDEN", message: `Unexpected operation: ${request.method}` } }) });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
      });

      await page.goto(`${baseUrl}/__delivery-archive-conflict-test`, { waitUntil: "domcontentloaded" });
      await page.getByRole("cell", { name: "并发归档客户", exact: true }).waitFor();
      await page.getByRole("button", { name: "查看详情", exact: true }).click();
      await page.getByRole("button", { name: "停用并删除记录", exact: true }).click();
      await page.getByRole("button", { name: "确认停用并删除", exact: true }).click();

      await page.getByText("共 0 条", { exact: true }).waitFor();
      expect(await page.getByRole("cell", { name: "并发归档客户", exact: true }).count()).toBe(0);
      expect(archiveWrites).toBe(1);
      expect(workspaceScopedRequests.filter(request => request.method === "ops.customer-delivery.list")).toHaveLength(2);
      expect(workspaceScopedRequests.filter(request => request.method === "ops.customer-delivery.get")).toHaveLength(1);
      expect(workspaceScopedRequests.filter(request => request.method === "ops.customer-delivery.update")).toHaveLength(1);
      expect(workspaceScopedRequests.every(request => request.workspaceId === "ws-archive-conflict")).toBe(true);
    } finally { await page.close(); }
  }, 45_000);
});
