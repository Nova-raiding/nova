import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Ops stores route directory and registration journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-stores-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-stores-route-${randomUUID()}`;
    const html = join(appRoot, `${harnessName}.html`);
    const entry = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [html, entry];
    await writeFile(html, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/stores?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client'; import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx'; localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'fixture-token',actorId:'fixture-operator'})); createRoot(document.getElementById('root')).render(React.createElement(OpsConsoleController));`, { flag: "wx" });
    vite = await createServer({
      configFile: false, root: appRoot, cacheDir: cacheDirectory, logLevel: "error",
      define: { "import.meta.env.VITE_API_BASE": JSON.stringify("/api"), "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"), "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("local"), "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("local") },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Stores route fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally { try { await vite?.close(); } finally { await Promise.all(harnessFiles.map(file => rm(file, { force: true }))); if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("filters the loaded directory, preserves a failed registration for retry, then refreshes the credential-free row", async () => {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const rpcCalls: Array<{ method: string; params: Record<string, unknown>; workspace?: string; workbench?: string }> = [];
    const unexpected: string[] = [];
    let registrationAttempts = 0;
    let registrationSucceeded = false;
    const store = (accountId: string, label: string, dataMode: string) => ({ platform: "taobao", accountId, label, state: "connected", dataMode, readable: true, writeEnabled: false, revision: 1 });
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname === "127.0.0.1" && url.port === new URL(baseUrl).port) return route.fallback();
        unexpected.push(url.origin); await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname.startsWith("/api/"), async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.pathname !== "/api/mcp" || request.method() !== "POST") { unexpected.push(`${request.method()} ${url.pathname}`); await route.fulfill({ status: 403, body: "fixture only" }); return; }
        const rpc = request.postDataJSON() as { id?: string | number; method: string; params?: Record<string, unknown> };
        rpcCalls.push({ method: rpc.method, params: rpc.params ?? {}, workspace: request.headers()["x-workspace-id"], workbench: request.headers()["x-ops-workbench"] });
        let result: unknown = null;
        if (rpc.method === "ops.session") result = { actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false, workbench: "platform", scope: { type: "platform" }, capabilities: ["platform.settings.read", "workspace.directory.read", "store.connection.update"] };
        if (rpc.method === "ops.workspaces.list") result = { items: [{ workspaceId: "ws-isolated", enterpriseName: "隔离工作区", status: "active" }], total: 1, offset: 0, limit: 20 };
        if (rpc.method === "ops.stores.list") result = { items: registrationSucceeded ? [store("known-1", "已授权测试店", "official_api"), { ...store("manual-fixture-1", "人工登记样例", "account_record_only"), state: "manually_registered" }] : [store("known-1", "已授权测试店", "official_api"), store("known-2", "另一家测试店", "official_api")] };
        if (rpc.method === "ops.platform.store.record.create") {
          registrationAttempts += 1;
          if (registrationAttempts === 1) {
            await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: "ACCOUNT_EXISTS", message: "该账号 ID 已登记，请核对后重试" } }) });
            return;
          }
          registrationSucceeded = true;
          result = { connection: { mode: "manual_store_record", token_state: "manually_registered", credential_free: true, authorization_receipt: null }, applies_to_store_boundary: true };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });
      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "平台连接汇总" }).waitFor();
      await page.getByText("已授权测试店", { exact: true }).waitFor();
      await page.getByPlaceholder("搜索店铺名称、账号 ID 或平台").fill("另一家");
      await expectText(page, "另一家测试店");
      await page.getByPlaceholder("搜索店铺名称、账号 ID 或平台").fill("missing");
      await page.getByText("没有匹配的店铺", { exact: true }).waitFor();
      await page.getByPlaceholder("搜索店铺名称、账号 ID 或平台").fill("");

      await page.getByRole("button", { name: "登记人工店铺", exact: true }).click();
      const dialog = page.locator(".ant-modal").filter({ hasText: "登记人工店铺" });
      await dialog.locator("#manual-store-workspace").click();
      await page.getByText("隔离工作区 · ws-isolated", { exact: true }).click();
      await dialog.locator("#manual-store-platform").click();
      await page.getByText("淘宝", { exact: true }).last().click();
      await dialog.getByLabel("平台店铺账号 ID", { exact: true }).fill("route-fixture-store");
      await dialog.getByLabel("登记理由", { exact: true }).fill("隔离路由验收");
      await dialog.getByRole("button", { name: "确认登记" }).click();
      await dialog.getByRole("alert").getByText("该账号 ID 已登记，请核对后重试", { exact: true }).waitFor();
      expect(await dialog.getByLabel("平台店铺账号 ID", { exact: true }).inputValue()).toBe("route-fixture-store");
      await dialog.getByRole("button", { name: "确认登记" }).click();
      await page.getByRole("status").filter({ hasText: "人工店铺已登记" }).waitFor();
      await page.getByText("人工登记样例", { exact: true }).waitFor();
      await page.getByText("人工登记（未授权）", { exact: true }).waitFor();
      const registrations = rpcCalls.filter(call => call.method === "ops.platform.store.record.create");
      expect(registrations).toHaveLength(2);
      expect(registrations[0]).toMatchObject({ params: { workspace_id: "ws-isolated", platform: "taobao", account_id: "route-fixture-store", reason: "隔离路由验收" }, workspace: undefined, workbench: "platform" });
      expect(unexpected).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("opens for directory-only operators and requests only reads granted by that capability", async () => {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const rpcCalls: Array<{ method: string; params: Record<string, unknown>; workbench?: string }> = [];
    const unexpected: string[] = [];
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname === "127.0.0.1" && url.port === new URL(baseUrl).port) return route.fallback();
        unexpected.push(url.origin); await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname.startsWith("/api/"), async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.pathname !== "/api/mcp" || request.method() !== "POST") {
          unexpected.push(`${request.method()} ${url.pathname}`); await route.fulfill({ status: 403, body: "fixture only" }); return;
        }
        const rpc = request.postDataJSON() as { id?: string | number; method: string; params?: Record<string, unknown> };
        rpcCalls.push({ method: rpc.method, params: rpc.params ?? {}, workbench: request.headers()["x-ops-workbench"] });
        let result: unknown = null;
        if (rpc.method === "ops.session") result = { actor_id: "directory-reader", workspace_id: "", roles: [], workspace_granted: false, workbench: "platform", scope: { type: "platform" }, capabilities: ["workspace.directory.read"] };
        if (rpc.method === "ops.workspaces.list") result = { items: [], total: 0, offset: 0, limit: 20 };
        if (rpc.method === "ops.stores.list") result = { items: [ { platform: "taobao", accountId: "readable-store", label: "目录可读店铺", state: "connected", dataMode: "official_api", readable: true, writeEnabled: false, revision: 1 } ] };
        if (rpc.method === "ops.growth.funnel") result = { counts: {}, totalEvents: 0 };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "平台与店铺", exact: true }).waitFor();
      await page.getByRole("heading", { name: "平台连接汇总" }).waitFor();
      await page.getByText("目录可读店铺", { exact: true }).waitFor();
      await page.waitForTimeout(1_800);

      expect(rpcCalls.filter(call => call.method !== "ops.session").map(call => call.method).sort()).toEqual([
        "ops.growth.funnel", "ops.stores.list", "ops.workspaces.list",
      ]);
      expect(rpcCalls.filter(call => call.method === "ops.stores.list")).toEqual([
        expect.objectContaining({ params: { platform_scope: "platform" }, workbench: "platform" }),
      ]);
      expect(rpcCalls.some(call => call.method.includes("create") || call.method.includes("update") || call.method.includes("delete"))).toBe(false);
      expect(unexpected).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});

async function expectText(page: import("playwright").Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).waitFor({ state: "visible" });
}
