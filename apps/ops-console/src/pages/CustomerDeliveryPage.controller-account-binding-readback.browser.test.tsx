import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

describe("CustomerDelivery controller account binding readback journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-account-binding-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-delivery-account-binding-route-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/customer-delivery?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'delivery-token',actorId:'delivery-operator'}));
      createRoot(document.getElementById('root')).render(React.createElement(OpsConsoleController));
    `, { flag: "wx" });
    vite = await createServer({
      configFile: false,
      root: appRoot,
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"),
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("local"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("local"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Customer delivery account binding route fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally {
        try { await Promise.all(harnessFiles.map(file => rm(file, { force: true }))); }
        finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
      }
    }
  }, 60_000);

  it("binds only the explicitly confirmed account and reads the binding back from the selected workspace", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    let bound = false;
    const workspaceId = "ws-delivery-account-binding-route";
    const account = { workspaceId, accountId: "account-fixture-93", identityId: "identity-fixture-93", login: "owner@delivery.example.test" };
    const record = {
      id: "delivery-account-binding-route", companyName: "账号关联验收客户", paymentStatus: "paid", contractNo: "CD-93",
      profile: true, integration: true, acceptance: true, training: false, revision: 6, videos: [],
    };
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(baseUrl).origin) {
          unexpectedRequests.push(url.origin);
          await route.abort();
          return;
        }
        if (url.pathname !== "/api/mcp") return route.fallback();
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { rpc = route.request().postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        calls.push({ method, params });
        let result: unknown = null;
        if (method === "ops.session") {
          result = {
            actor_id: "delivery-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["platform.summary.read", "customer.delivery.read", "customer.delivery.update", "workspace.directory.read"],
          };
        } else if (method === "ops.workspaces.list") {
          result = { items: [{ workspaceId, enterpriseName: "账号关联验收企业", status: "active" }], total: 1, offset: 0, limit: 100, hasMore: false };
        } else if (method === "ops.customer-delivery.list") {
          const archivedOnly = params.archived_only === "true";
          const items = archivedOnly ? [] : [bound ? { ...record, revision: 7, targetAccountId: account.accountId, targetIdentityId: account.identityId, targetAccountLogin: account.login } : record];
          result = { items, total: items.length, offset: Number(params.offset), limit: Number(params.limit), hasMore: false, project_owner_options: [], support_owner_options: [] };
        } else if (method === "ops.customer-delivery.videos.list") {
          result = { items: [] };
        } else if (method === "ops.customer-delivery.accounts.list") {
          result = { items: [account] };
        } else if (method === "ops.customer-delivery.account.bind") {
          expect(params).toMatchObject({ target_workspace_id: workspaceId, delivery_id: record.id, target_account_id: account.accountId, expected_revision: "6", reason: "已核对客户授权账号" });
          bound = true;
          result = { ...record, workspaceId, revision: 7, targetAccountId: account.accountId, targetIdentityId: account.identityId, targetAccountLogin: account.login };
        } else if (method === "ops.stores.list") {
          result = { items: [] };
        } else if (method === "ops.growth.funnel") {
          result = null;
        } else {
          unexpectedRequests.push(`unexpected RPC ${method}`);
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("region", { name: "客户交付" }).waitFor({ state: "visible" });
      const workspace = page.getByRole("combobox", { name: "客户交付目标企业工作区" });
      await workspace.click();
      await page.getByText("账号关联验收企业 · ws-delivery-account-binding-route", { exact: true }).click();
      const customerRow = page.locator("#ops-main-content").getByRole("row").filter({ hasText: "账号关联验收客户" });
      await customerRow.waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "ops.customer-delivery.list").at(-1)?.params).toMatchObject({ target_workspace_id: workspaceId, offset: "0", limit: "20" });
      await customerRow.getByRole("button", { name: "查看详情", exact: true }).click();
      const details = page.getByRole("dialog").filter({ hasText: "账号关联验收客户 · 客户详情" });
      await details.getByRole("button", { name: "编辑客户档案", exact: true }).click();
      const binding = page.getByRole("region", { name: "生效账号", exact: true });
      await binding.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "查询账号", exact: true }).click();
      const accountSelect = page.getByRole("combobox", { name: "选择生效账号", exact: true });
      await expect.poll(() => accountSelect.isEnabled()).toBe(true);
      await accountSelect.click();
      await page.getByText(account.login, { exact: true }).click();
      await page.getByLabel("关联原因（必填）", { exact: true }).fill("已核对客户授权账号");
      await page.getByRole("checkbox", { name: `我已核对登录账号，确认关联 ${account.login}`, exact: true }).check();
      expect(calls.filter(call => call.method === "ops.customer-delivery.account.bind")).toHaveLength(0);
      await page.getByRole("button", { name: "确认关联账号", exact: true }).click();
      await expect.poll(() => calls.filter(call => call.method === "ops.customer-delivery.account.bind").length).toBe(1);
      await expect.poll(async () => await binding.innerText()).toContain("已关联");
      expect(await binding.innerText()).toContain(account.login);
      const bindCalls = calls.filter(call => call.method === "ops.customer-delivery.account.bind");
      expect(bindCalls).toHaveLength(1);
      expect(bindCalls[0]?.params).toMatchObject({
        target_workspace_id: workspaceId, delivery_id: record.id, target_account_id: account.accountId,
        expected_revision: "6", reason: "已核对客户授权账号",
      });

      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "刷新交付档案", exact: true }).click();
      expect(calls.filter(call => call.method === "ops.customer-delivery.list").at(-1)?.params).toMatchObject({ target_workspace_id: workspaceId, offset: "0", limit: "20" });
      await customerRow.getByRole("button", { name: "查看详情", exact: true }).click();
      const readbackDetails = page.getByRole("dialog").filter({ hasText: "账号关联验收客户 · 客户详情" });
      await readbackDetails.getByText(account.login, { exact: true }).waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "ops.customer-delivery.list")).toHaveLength(2);
      expect(calls.filter(call => call.method === "ops.customer-delivery.account.bind")).toHaveLength(1);
      expect(calls.filter(call => call.method.startsWith("ops.customer-delivery.")).every(call => call.params.target_workspace_id === workspaceId)).toBe(true);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
