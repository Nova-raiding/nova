import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown>; workbench?: string; workspace?: string };

describe("StoresPage controller authorization revoke readback journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-stores-revoke-readback-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-stores-revoke-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/stores?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'stores-token',actorId:'stores-operator'}));
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
    if (!address || typeof address === "string") throw new Error("Stores revoke controller listener did not bind");
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

  for (const failReadback of [false, true]) it(`revokes the scoped account once and reads back revoked state (readback failure: ${failReadback})`, async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    let revoked = false;
    let allowReadback = !failReadback;
    const store = () => ({
      platform: "taobao", accountId: "account:sku-51", alias: "",
      label: "淘宝已授权店", state: revoked ? "revoked" : "connected", dataMode: "official_api", readable: !revoked, writeEnabled: false,
      revision: revoked ? 12 : 11,
    });
    try {
      page.on("pageerror", error => browserErrors.push(error.message));
      page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin) return route.fallback();
        unexpectedRequests.push(url.origin);
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname.startsWith("/api/"), async route => {
        const request = route.request();
        if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/mcp") {
          unexpectedRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "fixture blocks non-RPC requests" }) });
          return;
        }
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { rpc = request.postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        calls.push({ method, params, workbench: request.headers()["x-ops-workbench"], workspace: request.headers()["x-workspace-id"] });
        let result: unknown = null;
        if (method === "ops.session") result = {
          actor_id: "stores-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" },
          capabilities: ["platform.settings.read", "workspace.directory.read", "store.connection.update"],
          effective_permissions: [
            { capability: "platform.settings.read", effect: "allow", scope: { type: "platform" } },
            { capability: "workspace.directory.read", effect: "allow", scope: { type: "platform" } },
            { capability: "store.connection.update", effect: "allow", scope: { type: "account", ids: ["account:sku-51"] } },
          ],
        };
        else if (method === "ops.stores.list" && revoked && !allowReadback) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32000, message: "店铺目录回读暂时不可用" } }) });
        }
        else if (method === "ops.stores.list") result = { items: [store(), { ...store(), accountId: "account:sku-52", label: "只读未变店铺", state: "connected", readable: true, revision: 4 }], total: 2, offset: 0, limit: 20 };
        else if (method === "ops.workspaces.list") result = { items: [], total: 0, offset: 0, limit: 20 };
        else if (method === "platform.revoke") { revoked = true; result = { success: true }; }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "平台连接汇总" }).waitFor({ state: "visible" });
      await page.getByText("淘宝已授权店", { exact: true }).waitFor({ state: "visible" });
      const storeRow = page.getByRole("row").filter({ hasText: "淘宝已授权店" });
      await storeRow.getByRole("button", { name: "撤销", exact: true }).click();
      const dialog = page.getByRole("dialog").filter({ hasText: "确认撤销平台授权？" });
      await dialog.waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "platform.revoke")).toHaveLength(0);
      await dialog.getByRole("button", { name: "确认撤销", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });

      const revokeCalls = calls.filter(call => call.method === "platform.revoke");
      expect(revokeCalls).toHaveLength(1);
      expect(revokeCalls[0]).toMatchObject({
        params: { platform: "taobao", account_id: "account:sku-51" },
        workbench: "platform",
        workspace: undefined,
      });
      await expectEventually(() => calls.filter(call => call.method === "ops.stores.list").length >= 2);
      const refreshedRow = page.getByRole("row").filter({ hasText: "淘宝已授权店" });
      await refreshedRow.getByText("已撤销", { exact: true }).waitFor({ state: "visible" });
      expect(await refreshedRow.getByRole("button", { name: "撤销", exact: true }).count()).toBe(0);
      if (failReadback) {
        await page.getByRole("group", { name: "店铺目录读取失败" }).waitFor({ state: "visible" });
        await page.locator('[aria-label="平台汇总错误摘要"]').getByText("店铺目录回读暂时不可用", { exact: false }).waitFor({ state: "visible" });
        allowReadback = true;
        await page.getByRole("button", { name: "刷新连接", exact: true }).click();
        await expectEventually(() => calls.filter(call => call.method === "ops.stores.list").length >= 3);
        await refreshedRow.getByText("已撤销", { exact: true }).waitFor({ state: "visible" });
      }
      const untouchedRow = page.getByRole("row").filter({ hasText: "只读未变店铺" });
      await untouchedRow.getByText("真实授权", { exact: true }).waitFor({ state: "visible" });
      expect(await untouchedRow.getByRole("button", { name: "撤销", exact: true }).isDisabled()).toBe(true);
      expect(calls.filter(call => call.method === "platform.revoke")).toHaveLength(1);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);
});

async function expectEventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(predicate()).toBe(true);
}
