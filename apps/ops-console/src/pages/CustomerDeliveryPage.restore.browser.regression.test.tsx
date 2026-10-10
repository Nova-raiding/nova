import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("customer delivery archive restore", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-restore-"));
    const entryPath = "/__delivery-restore-entry.tsx";
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
        name: "delivery-restore-regression",
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
            if (!req.url?.startsWith("/__delivery-restore-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Delivery restore listener did not bind");
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

  it("restores an archived record with its workspace and current revision", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8_000);
    const listRequests: Array<{ workspace: string; archivedOnly: string | undefined }> = [];
    let restored = false;
    let updateParams: Record<string, string> | undefined;
    const archivedRecord = {
      id: "delivery-archived",
      companyName: "待恢复客户",
      paymentStatus: "paid",
      profile: true,
      integration: true,
      acceptance: true,
      training: true,
      revision: 7,
      archivedAt: "2026-10-09T10:00:00.000Z",
      videos: [],
    };

    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
        let result: unknown;
        if (request.method === "ops.customer-delivery.list") {
          listRequests.push({ workspace: request.params.target_workspace_id, archivedOnly: request.params.archived_only });
          const isArchivedView = request.params.archived_only === "true";
          const items = isArchivedView && !restored ? [archivedRecord] : [];
          result = { items, total: items.length, offset: Number(request.params.offset), limit: Number(request.params.limit), hasMore: false, project_owner_options: [], support_owner_options: [] };
        } else if (request.method === "ops.customer-delivery.update") {
          updateParams = request.params;
          restored = true;
          result = { ...archivedRecord, archivedAt: null, revision: 8 };
        } else {
          return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "FORBIDDEN", message: `Unexpected operation: ${request.method}` } }) });
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
      });

      await page.goto(`${baseUrl}/__delivery-restore-test`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.getByRole("checkbox", { name: "查看已归档记录" }).check();
      await page.getByRole("cell", { name: "待恢复客户", exact: true }).waitFor();
      await page.getByRole("button", { name: "恢复记录", exact: true }).click();
      await page.getByRole("button", { name: "确认恢复", exact: true }).click();
      await page.getByText("客户交付记录已恢复", { exact: true }).waitFor();
      await page.getByText("暂无已归档客户交付记录", { exact: true }).waitFor();

      expect(listRequests).toEqual([
        { workspace: "ws-regression", archivedOnly: undefined },
        { workspace: "ws-regression", archivedOnly: "true" },
        { workspace: "ws-regression", archivedOnly: "true" },
      ]);
      expect(updateParams).toMatchObject({
        target_workspace_id: "ws-regression",
        delivery_id: "delivery-archived",
        expected_revision: "7",
      });
      expect(JSON.parse(updateParams!.patch_json)).toEqual({ archivedAt: null });
      expect(restored).toBe(true);
    } finally { await page.close(); }
  }, 45_000);
});
