import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

describe("customer delivery workspace switch response isolation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(joinPath(tmpdir(), "ops-delivery-workspace-race-"));
    const entryPath = "/__delivery-workspace-race-entry.tsx";
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
        name: "delivery-workspace-race-regression",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { CustomerDeliveryPage } from '/src/pages/CustomerDeliveryPage.tsx';
            import { UnsavedChangesProvider } from '/src/components/authz/UnsavedChangesContext.tsx';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            function Harness() {
              const [workspace, setWorkspace] = useState('ws-a');
              const model = {
                authorization: { can: capability => capability === 'customer.delivery.read' || capability === 'customer.delivery.update' || capability === 'workspace.directory.read' },
                authorizationTargetWorkspaceId: workspace,
                setAuthorizationTargetWorkspaceId: setWorkspace,
                loadWorkspaceDirectory: async () => {},
                workspaceDirectoryLoading: false,
                workspaceRows: [
                  { workspaceId: 'ws-a', enterpriseName: '企业 A', status: 'active' },
                  { workspaceId: 'ws-b', enterpriseName: '企业 B', status: 'active' },
                ],
              };
              return React.createElement(UnsavedChangesProvider, null,
                React.createElement(App, null,
                  React.createElement('button', { onClick: () => setWorkspace('ws-b') }, '切换到企业 B'),
                  React.createElement(CustomerDeliveryPage, { model })));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__delivery-workspace-race-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Delivery workspace race listener did not bind");
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

  it("never renders a delayed list response from the previous selected workspace", async () => {
    const page: Page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    let releaseWorkspaceA!: () => void;
    const workspaceAResponse = new Promise<void>(resolve => { releaseWorkspaceA = resolve; });
    const observedWorkspaces: string[] = [];
    const browserErrors: string[] = [];
    const browserRequests: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
    page.on("requestfailed", request => browserErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
    page.on("request", request => browserRequests.push(`${request.method()} ${request.url()}`));
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
        if (request.method !== "ops.customer-delivery.list") {
          return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Unexpected operation" } }) });
        }
        const workspaceId = request.params.target_workspace_id;
        observedWorkspaces.push(workspaceId);
        if (workspaceId === "ws-a") await workspaceAResponse;
        const companyName = workspaceId === "ws-a" ? "仅属于企业 A 的档案" : "仅属于企业 B 的档案";
        const record = {
          id: `delivery-${workspaceId}`, workspaceId, companyName, paymentStatus: "unpaid", revision: 1,
          customerProfileStatus: "incomplete", systemIntegrationStatus: "incomplete",
          functionalAcceptanceStatus: "incomplete", trainingCompleted: false, videos: [],
        };
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: { items: [record], total: 1, offset: 0, limit: 20, hasMore: false, project_owner_options: [], support_owner_options: [] },
        }) });
      });
      await page.goto(`${baseUrl}/__delivery-workspace-race-test`);
      page.setDefaultTimeout(3_000);
      await page.waitForTimeout(500);
      expect(await page.locator("body").innerText(), JSON.stringify({ browserRequests, browserErrors })).toContain("客户建档");
      await expect.poll(() => observedWorkspaces, { message: `workspace requests=${JSON.stringify(observedWorkspaces)} browser errors=${JSON.stringify(browserErrors)}` }).toEqual(["ws-a"]);

      await page.getByRole("button", { name: "切换到企业 B", exact: true }).click();
      await page.getByRole("cell", { name: "仅属于企业 B 的档案", exact: true }).waitFor();
      expect(observedWorkspaces).toEqual(["ws-a", "ws-b"]);

      // The old request is now completed after the new workspace has loaded.
      // Its response must not replace or leak the selected workspace's rows.
      releaseWorkspaceA();
      await page.waitForTimeout(100);
      expect(await page.getByRole("cell", { name: "仅属于企业 A 的档案", exact: true }).count()).toBe(0);
      expect(await page.getByRole("cell", { name: "仅属于企业 B 的档案", exact: true }).count()).toBe(1);
    } finally {
      releaseWorkspaceA();
      await page.close();
    }
  }, 45_000);
});

function joinPath(...parts: string[]) { return parts.join("/"); }
