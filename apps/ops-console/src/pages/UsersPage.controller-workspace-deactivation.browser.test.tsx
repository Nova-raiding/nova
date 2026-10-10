import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("UsersPage platform workspace deactivation controller journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-users-workspace-state-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-users-workspace-state-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/users?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'fixture-token', actorId: 'fixture-operator'}));
      createRoot(document.getElementById('root')).render(React.createElement(OpsConsoleController));
    `, { flag: "wx" });
    vite = await createServer({
      configFile: false, root: appRoot, cacheDir: cacheDirectory, logLevel: "error",
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
    if (!address || typeof address === "string") throw new Error("Users workspace status controller listener did not bind");
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

  it("requires confirmation, deactivates only the selected workspace, and reads its disabled state back", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    const rpcCalls: Array<{ method: string; params: Record<string, unknown>; workspace: string | undefined; workbench: string | undefined }> = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    let disabled = false;
    const workspaces = () => [{
      workspaceId: "workspace-safe-fixture", enterpriseName: "隔离验收企业", status: disabled ? "disabled" : "active",
      planName: "Starter", monthlyPriceCny: 199, usedTasks: 0, includedTasks: 30,
      subscriptionStatus: "trialing", memberCount: 1,
    }];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin) return route.fallback();
        unexpectedRequests.push(url.origin);
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname === "/api/mcp", async route => {
        const request = route.request();
        if (request.method() !== "POST") {
          unexpectedRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
          await route.fulfill({ status: 405, body: "method not allowed" });
          return;
        }
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { rpc = request.postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        rpcCalls.push({ method, params, workspace: request.headers()["x-workspace-id"], workbench: request.headers()["x-ops-workbench"] });
        let result: unknown = null;
        if (method === "ops.session") result = {
          actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" }, capabilities: ["identity.read", "workspace.directory.read", "workspace.status.update"],
        };
        else if (method === "ops.users.list") result = { items: [], total: 0, identityCount: 0, workspaceCount: 1, offset: 0, limit: 10, truncated: false };
        else if (method === "ops.workspaces.list") result = { items: workspaces(), total: 1, offset: 0, limit: 20 };
        else if (method === "ops.stores.list") result = { items: [], total: 0, offset: 0, limit: 20 };
        else if (method === "ops.growth.funnel") result = { counts: {}, totalEvents: 0 };
        else if (method === "workspace.deactivate") disabled = true;
        else if (method !== "ops.bootstrap" && method !== "ops.alerts.list") unexpectedRequests.push(`unexpected RPC ${method}`);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "已接入用户" }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: /更多用户治理操作/u }).click();
      await page.getByRole("menuitem", { name: "商家工作区", exact: true }).click();
      const row = page.getByRole("row").filter({ hasText: "workspace-safe-fixture" });
      await row.waitFor({ state: "visible" });
      await row.getByRole("button", { name: "停用租户" }).waitFor({ state: "visible" });
      expect(await rpcCalls.filter(call => call.method === "workspace.deactivate")).toHaveLength(0);

      await row.getByRole("button", { name: "停用租户" }).click();
      const dialog = page.locator(".ant-modal");
      await dialog.waitFor({ state: "visible" });
      await dialog.getByLabel(/操作原因/u).fill("隔离验收停用原因");
      expect(rpcCalls.filter(call => call.method === "workspace.deactivate")).toHaveLength(0);
      await dialog.getByRole("button", { name: "确认停用" }).click();
      const readbackRow = page.getByRole("row").filter({ hasText: "workspace-safe-fixture" });
      await readbackRow.getByRole("button", { name: "恢复租户" }).waitFor({ state: "visible" });

      const write = rpcCalls.filter(call => call.method === "workspace.deactivate");
      expect(write).toHaveLength(1);
      expect(write[0]).toMatchObject({
        params: { reason: "隔离验收停用原因", workspace_id: "workspace-safe-fixture" }, workbench: "platform",
      });
      expect(rpcCalls.filter(call => call.method === "ops.workspaces.list").length).toBeGreaterThanOrEqual(2);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
