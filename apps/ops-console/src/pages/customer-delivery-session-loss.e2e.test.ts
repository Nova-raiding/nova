import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

// Isolated desktop UI evidence only: the harness drops the page's effective
// read/write authorization. It does not claim to exercise real login, token
// expiry, API authentication, or database/RLS enforcement.
describe("customer delivery session-loss UI boundary", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  const entryPath = "/__customer-delivery-session-loss-entry.tsx";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(joinPath(tmpdir(), "ops-delivery-session-loss-"));
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
        name: "customer-delivery-session-loss-regression",
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
              const [authorized, setAuthorized] = useState(true);
              const workspace = 'ws-session-loss-a';
              const model = {
                authorization: { can: capability => capability === 'customer.delivery.read' ? authorized : capability === 'customer.delivery.update' ? authorized : capability === 'workspace.directory.read' },
                authorizationTargetWorkspaceId: workspace,
                setAuthorizationTargetWorkspaceId: () => {},
                loadWorkspaceDirectory: async () => {},
                workspaceDirectoryLoading: false,
                workspaceRows: [{ workspaceId: workspace, enterpriseName: '隔离会话测试企业', status: 'active' }],
              };
              return React.createElement(App, null,
                React.createElement('button', { onClick: () => setAuthorized(false) }, '模拟会话失效'),
                React.createElement(CustomerDeliveryPage, { model }));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__customer-delivery-session-loss-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Customer delivery session-loss listener did not bind");
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

  async function openPage(page: Page, listResponse: (route: import("playwright").Route, request: { id: string; method: string; params: Record<string, string> }) => Promise<void>) {
    const calls: Array<{ method: string; targetWorkspaceId?: string }> = [];
    await page.route(`${baseUrl}/api/mcp`, async route => {
      const request = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
      calls.push({ method: request.method, targetWorkspaceId: request.params.target_workspace_id });
      if (request.method === "ops.customer-delivery.list") return listResponse(route, request);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [] }) });
    });
    await page.goto(`${baseUrl}/__customer-delivery-session-loss-test`);
    return calls;
  }

  it("clears previously visible tenant data and disables refresh when read authorization is lost", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const calls = await openPage(page, (route, request) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        result: { items: [{ id: "delivery-session-loss", workspaceId: request.params.target_workspace_id, companyName: "失效前可见客户资料", paymentStatus: "paid", profile: true, integration: true, acceptance: true, training: false, revision: 1, videos: [] }], total: 1, offset: 0, limit: 20, hasMore: false, project_owner_options: [], support_owner_options: [] },
      }) }));
      await page.getByRole("cell", { name: "失效前可见客户资料", exact: true }).waitFor();
      expect(calls).toEqual([{ method: "ops.customer-delivery.list", targetWorkspaceId: "ws-session-loss-a" }]);

      await page.getByRole("button", { name: "模拟会话失效", exact: true }).click();
      await page.getByText("当前会话没有客户交付读取权限", { exact: true }).waitFor();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.getByRole("cell", { name: "失效前可见客户资料", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "刷新交付档案", exact: true }).isDisabled()).toBe(true);
      expect(calls).toHaveLength(1);
    } finally { await page.close(); }
  }, 45_000);

  it("ignores a same-workspace list response that arrives after read authorization is lost", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    try {
      const calls = await openPage(page, async (route, request) => {
        await responseGate;
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: { items: [{ id: "delivery-late-session-loss", workspaceId: request.params.target_workspace_id, companyName: "会话失效后迟到的客户资料", paymentStatus: "paid", profile: true, integration: true, acceptance: true, training: false, revision: 1, videos: [] }], total: 1, offset: 0, limit: 20, hasMore: false, project_owner_options: [], support_owner_options: [] },
        }) });
      });
      await expect.poll(() => calls.length).toBe(1);
      await page.getByRole("button", { name: "模拟会话失效", exact: true }).click();
      await page.getByText("当前会话没有客户交付读取权限", { exact: true }).waitFor();
      releaseResponse();
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.getByRole("cell", { name: "会话失效后迟到的客户资料", exact: true }).count()).toBe(0);
      expect(calls).toEqual([{ method: "ops.customer-delivery.list", targetWorkspaceId: "ws-session-loss-a" }]);
    } finally { releaseResponse(); await page.close(); }
  }, 45_000);
});

function joinPath(...parts: string[]) { return parts.join("/"); }
