import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

// This route journey traverses the real controller, page registry,
// authorization projection, SupportRoute, page, and platform support client.
// RPC results are local fixtures; this is not Demo tenant evidence.
describe("platform support route browser journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-support-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-support-route-${randomUUID()}`;
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
    if (!address || typeof address === "string") throw new Error("Support route test listener did not bind");
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

  it("selects an authorized enterprise, retries a failed queue read, and opens its ticket by keyboard", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    let failQueueRead = true;
    const ticket = {
      id: "support-route-ticket", workspaceId: "ws-support-route", ticketNumber: "SUP-42",
      subject: "客户无法查看生成结果", description: "已核实任务成功，但客户页面没有结果。",
      status: "open", priority: "normal", customerId: "customer-42", customerName: "测试客户",
      tags: ["generation"], revision: 2, createdBy: "merchant-user",
      createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
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
            capabilities: ["platform.summary.read", "support.ticket.read", "support.ticket.update", "workspace.directory.read"],
          };
        } else if (method === "ops.workspaces.list") {
          result = { items: [{ workspaceId: "ws-support-route", enterpriseName: "客服旅程企业", status: "active", planName: "test", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 0, subscriptionStatus: "active", memberCount: 1 }], total: 1, offset: 0, limit: 20, hasMore: false };
        } else if (method === "ops.support.platform.tickets.list") {
          if (failQueueRead) {
            failQueueRead = false;
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32000, message: "support queue temporarily unavailable" } }) });
            return;
          }
          result = { items: [ticket] };
        } else if (method === "ops.support.platform.ticket.get") {
          result = { ticket, events: [] };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "客服工作台" }).click();
      await page.getByRole("heading", { name: "客服工作台" }).waitFor();
      await page.getByRole("button", { name: "读取授权企业目录" }).click();
      await page.getByRole("combobox", { name: "选择支持目标企业" }).click();
      await page.getByText(/客服旅程企业 · ws-support-route/).click();
      const readQueue = page.getByRole("button", { name: "读取企业工单" });
      await readQueue.click();
      await page.getByRole("alert").getByText("support queue temporarily unavailable").waitFor();
      await page.getByText("尚未读取所选企业真实工单，不表示没有问题。").waitFor();
      await readQueue.click();
      await page.getByText("SUP-42", { exact: true }).waitFor();
      const detailButton = page.getByRole("button", { name: "查看 SUP-42" });
      await detailButton.focus();
      await detailButton.press("Enter");
      await page.getByText("已核实任务成功，但客户页面没有结果。", { exact: true }).waitFor();
      expect(calls.filter(call => call.method === "ops.support.platform.tickets.list").map(call => call.params)).toEqual([
        { target_workspace_id: "ws-support-route", limit: "20" },
        { target_workspace_id: "ws-support-route", limit: "20" },
      ]);
      expect(calls.find(call => call.method === "ops.support.platform.ticket.get")?.params).toEqual({ target_workspace_id: "ws-support-route", ticket_id: "support-route-ticket" });
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
