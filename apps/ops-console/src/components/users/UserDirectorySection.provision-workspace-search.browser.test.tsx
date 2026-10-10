import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Ops /ops/users merchant account provisioning", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-provision-workspace-search-"));
    const entryPath = "/__provision-workspace-search-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"),
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("oidc"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("oidc"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "isolated-provision-workspace-search",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { UsersPage } from '/src/pages/UsersPage.tsx';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'fixture-token', actorId: 'fixture-operator' }));
            function Fixture() {
              if (!window.__requests) window.__requests = [];
              const [directory, setDirectory] = useState({items: [], offset: 0, limit: 100, hasMore: false});
              const model = {
                authorization: {can: capability => capability === 'identity.read', canAny: () => false, roles: [], scope: {kind: 'platform'}},
                userDirectory: {items: [], total: 0, identityCount: 0, workspaceCount: 0, offset: 0, limit: 20, truncated: false},
                userDirectoryLoading: false, userDirectoryError: '', userExporting: false,
                canPlatformOps: true, canUserGovernance: false, userDetail: undefined, userDetailLoading: false,
                opsSession: {actor_id: 'fixture-operator'}, error: undefined, load: async () => undefined,
                loadUsers: async () => undefined, cancelUserRequests: () => undefined,
                workspaceDirectoryLoading: false, workspaceDirectoryError: '',
                get workspaceDirectory() { return directory; },
                loadWorkspaceDirectory: async filters => {
                  window.__requests.push(filters);
                  const row = {workspaceId: 'ws_workspace_101', enterpriseName: '第101家目标企业', status: 'active'};
                  setDirectory({items: filters.query ? [row] : [], offset: 0, limit: 100, hasMore: false});
                  return true;
                },
              };
              return React.createElement(App, null, React.createElement(UsersPage, {model}));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Fixture));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/ops/users")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Provision workspace search listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("server-searches and selects a matching workspace beyond the initial 100-row page", async () => {
    if (!browser) throw new Error("Browser did not start");
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(30_000);
    try {
      let provisioningPayload: Record<string, unknown> | undefined;
      await page.route("**/api/v1/ops/merchant-accounts", async route => {
        provisioningPayload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
          account: { id: "acct_fixture", login: "buyer@example.com", workspaceIds: ["ws_workspace_101"], status: "invited" },
          invitation: { id: "invite_fixture", expires_at: "2026-10-11T00:00:00Z", status: "pending", replayed: false, delivery_status: "not_sent" },
          commercial_qualification_granted: false, capabilities_granted: [],
        } }) });
      });
      await page.goto(`${baseUrl}/ops/users`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /更多用户治理操作/u }).click();
      await page.getByRole("menuitem", { name: "开通商家账号" }).click();
      const dialog = page.getByRole("dialog", { name: "邀请客户激活登录账号" });
      await dialog.getByLabel("企业工作区").click();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await dialog.getByLabel("搜索要绑定的企业工作区").fill("第101家目标企业");
      await dialog.getByRole("button", { name: "查询企业工作区" }).click();
      await dialog.getByLabel("目标企业").click();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await dialog.getByTitle("第101家目标企业 · ws_workspace_101").waitFor({ state: "visible" });
      const request = await page.evaluate(() => window.__requests.at(-1));
      expect(request).toMatchObject({ query: "第101家目标企业", status: "active", merchantOnly: true, page: 1, pageSize: 100 });
      await dialog.getByLabel("商家登录邮箱").fill("buyer@example.com");
      await dialog.getByLabel("企业名称").fill("目标企业");
      await dialog.getByLabel("联系人").fill("测试联系人");
      await dialog.getByLabel("开户或邀请原因").fill("已核实客户身份后邀请");
      await dialog.getByRole("button", { name: "创建账号与安全邀请" }).click();
      await dialog.getByText("邀请标识：", { exact: false }).waitFor({ state: "visible" });
      expect(provisioningPayload).toMatchObject({ workspace_ids: ["ws_workspace_101"], create_workspace: false, action: "create" });
    } finally { await page.close(); }
  }, 60_000);

  it("preserves an ambiguous invitation intent across closing and reopening the route modal", async () => {
    if (!browser) throw new Error("Browser did not start");
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(30_000);
    const payloads: Array<Record<string, unknown>> = [];
    try {
      await page.route("**/api/v1/ops/merchant-accounts", async route => {
        payloads.push(route.request().postDataJSON() as Record<string, unknown>);
        if (payloads.length === 1) {
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "邀请服务暂时不可用" } }) });
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
          account: { id: "acct_recovered_fixture", login: "recovery@example.test", workspaceIds: [], status: "invited" },
          invitation: { id: "invite_recovered_fixture", expires_at: "2026-10-11T00:00:00Z", status: "pending", replayed: true, delivery_status: "not_sent" },
          commercial_qualification_granted: false, capabilities_granted: [],
        } }) });
      });
      await page.goto(`${baseUrl}/ops/users`, { waitUntil: "domcontentloaded" });
      const openProvision = async () => {
        await page.getByRole("button", { name: /更多用户治理操作/u }).click();
        await page.getByRole("menuitem", { name: "开通商家账号" }).click();
        return page.getByRole("dialog", { name: "邀请客户激活登录账号" });
      };
      let dialog = await openProvision();
      await dialog.getByLabel("商家登录邮箱").fill("recovery@example.test");
      await dialog.getByLabel("企业名称").fill("恢复验证企业");
      await dialog.getByLabel("联系人").fill("测试联系人");
      await dialog.getByLabel("开户或邀请原因").fill("验证请求结果恢复");
      await dialog.getByRole("button", { name: "创建账号与安全邀请" }).click();
      await dialog.getByText("邀请结果待确认", { exact: true }).waitFor({ state: "visible" });
      const firstIntent = payloads[0]!;
      expect(firstIntent).toMatchObject({ login: "recovery@example.test", enterprise_name: "恢复验证企业", action: "create" });

      await dialog.locator(".ant-modal-footer button").first().click();
      dialog = await openProvision();
      expect(await dialog.getByLabel("商家登录邮箱").inputValue()).toBe("recovery@example.test");
      expect(await dialog.getByRole("button", { name: "查询原邀请结果" }).count()).toBe(1);
      await dialog.getByRole("button", { name: "查询原邀请结果" }).click();
      await dialog.getByText("invite_recovered_fixture").waitFor({ state: "visible" });
      expect(payloads).toHaveLength(2);
      expect(payloads[1]).toEqual(firstIntent);
    } finally { await page.close(); }
  }, 60_000);
});

declare global { interface Window { __requests: Array<Record<string, unknown>> } }
