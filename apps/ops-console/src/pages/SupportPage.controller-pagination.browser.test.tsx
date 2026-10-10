import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

describe("platform support controller ticket pagination journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-support-pagination-controller-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-support-pagination-controller-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/overview?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'fixture-token',actorId:'fixture-operator'}));
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
    if (!address || typeof address === "string") throw new Error("Support pagination controller listener did not bind");
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

  it("loads the next support ticket page and returns to cached results without another RPC", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const cursor = { createdAt: "2026-10-10T00:00:00.000Z", id: "support-page-2" };
    const ticket1 = {
      id: "support-page-1", workspaceId: "ws-support-pages", ticketNumber: "SUP-101",
      subject: "第一页隔离工单", description: "本地分页夹具第一页。", status: "open", priority: "normal",
      customerId: "customer-101", customerName: "分页样例客户一", tags: [], revision: 2,
      createdBy: "merchant-user", createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
    };
    const ticket2 = {
      id: "support-page-2", workspaceId: "ws-support-pages", ticketNumber: "SUP-102",
      subject: "第二页隔离工单", description: "本地分页夹具第二页。", status: "open", priority: "high",
      customerId: "customer-102", customerName: "分页样例客户二", tags: [], revision: 1,
      createdBy: "merchant-user", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
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
        catch { await route.fulfill({ status: 400, body: "malformed fixture RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        calls.push({ method, params });
        let result: unknown = null;
        if (method === "ops.session") {
          result = {
            actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["platform.summary.read", "support.ticket.read", "workspace.directory.read"],
          };
        } else if (method === "ops.workspaces.list") {
          result = { items: [{ workspaceId: "ws-support-pages", enterpriseName: "分页验收企业", status: "active", planName: "test", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 0, subscriptionStatus: "active", memberCount: 1 }], total: 1, offset: 0, limit: 20, hasMore: false };
        } else if (method === "ops.support.platform.tickets.list") {
          const cursorJson = params.cursor_json;
          result = cursorJson === undefined ? { items: [ticket1], nextCursor: cursor } : { items: [ticket2] };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "客服工作台" }).click();
      await page.getByRole("heading", { name: "客服工作台" }).waitFor();
      await page.getByRole("button", { name: "读取授权企业目录" }).click();
      await page.getByRole("combobox", { name: "选择支持目标企业" }).click();
      await page.getByText(/分页验收企业 · ws-support-pages/).click();
      await page.getByRole("button", { name: "读取企业工单" }).click();
      await page.getByText("SUP-101", { exact: true }).waitFor({ state: "visible" });
      const listCalls = () => calls.filter(call => call.method === "ops.support.platform.tickets.list");
      expect(listCalls()).toHaveLength(1);
      expect(listCalls()[0]?.params).toEqual({ target_workspace_id: "ws-support-pages", limit: "20" });

      await page.locator("button").filter({ hasText: "下一页工单" }).click();
      await page.getByText("SUP-102", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("第 2 页", { exact: true }).waitFor({ state: "visible" });
      expect(listCalls()).toHaveLength(2);
      expect(listCalls()[1]?.params).toEqual({ target_workspace_id: "ws-support-pages", limit: "20", cursor_json: JSON.stringify(cursor) });

      await page.locator("button").filter({ hasText: "上一页工单" }).click();
      await page.getByText("SUP-101", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("第 1 页", { exact: true }).waitFor({ state: "visible" });
      expect(listCalls()).toHaveLength(2);
      await page.locator("button").filter({ hasText: "下一页工单" }).click();
      await page.getByText("SUP-102", { exact: true }).waitFor({ state: "visible" });
      expect(listCalls()).toHaveLength(2);
      expect(calls.some(call => /(?:create|update|delete|assign|comment|transition)/iu.test(call.method))).toBe(false);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
