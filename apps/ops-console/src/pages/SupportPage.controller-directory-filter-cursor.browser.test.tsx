import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

describe("Support controller directory filter and ticket cursor journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-support-filter-cursor-controller-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-support-filter-cursor-controller-${randomUUID()}`;
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
    if (!address || typeof address === "string") throw new Error("Support directory filter controller listener did not bind");
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

  it("filters the authorized directory and starts each selected workspace at its first ticket cursor", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const cursor = { createdAt: "2026-10-10T00:00:00.000Z", id: "filtered-support-page-2" };
    const ticket = (id: string, number: string, subject: string, workspaceId: string) => ({
      id, workspaceId, ticketNumber: number, subject, description: "本地筛选分页夹具。", status: "open", priority: "normal",
      customerId: `${id}-customer`, customerName: `${id} 客户`, tags: [], revision: 1,
      createdBy: "fixture-merchant", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
    });
    const first = ticket("filtered-1", "SUP-F-1", "筛选企业第一页工单", "ws-support-filtered");
    const second = ticket("filtered-2", "SUP-F-2", "筛选企业第二页工单", "ws-support-filtered");
    const other = ticket("other-1", "SUP-O-1", "另一企业首屏工单", "ws-support-other");
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
        if (method === "ops.session") result = {
          actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" },
          capabilities: ["platform.summary.read", "support.ticket.read", "workspace.directory.read"],
        };
        else if (method === "ops.workspaces.list") {
          const isFiltered = params.query === "筛选企业";
          result = {
            items: [{ workspaceId: isFiltered ? "ws-support-filtered" : "ws-support-other", enterpriseName: isFiltered ? "筛选企业" : "另一企业", status: "active", planName: "fixture", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 0, subscriptionStatus: "active", memberCount: 1 }],
            total: 1, offset: Number(params.offset ?? 0), limit: Number(params.limit ?? 20), hasMore: false,
          };
        } else if (method === "ops.support.platform.tickets.list") {
          if (params.target_workspace_id === "ws-support-filtered" && params.cursor_json === undefined) result = { items: [first], nextCursor: cursor };
          else if (params.target_workspace_id === "ws-support-filtered" && params.cursor_json === JSON.stringify(cursor)) result = { items: [second] };
          else if (params.target_workspace_id === "ws-support-other" && params.cursor_json === undefined) result = { items: [other] };
          else unexpectedRequests.push(`unexpected support list params ${JSON.stringify(params)}`);
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "客服工作台" }).click();
      await page.getByRole("heading", { name: "客服工作台" }).waitFor();
      await page.getByRole("textbox", { name: "搜索支持企业" }).fill("筛选企业");
      await page.getByRole("button", { name: "读取授权企业目录" }).click();
      await page.getByRole("combobox", { name: "选择支持目标企业" }).click();
      await page.getByText(/筛选企业 · ws-support-filtered/).click();
      const workspaceReads = () => calls.filter(call => call.method === "ops.workspaces.list");
      await expect.poll(() => workspaceReads().some(call => call.params.query === "筛选企业")).toBe(true);
      expect(workspaceReads().filter(call => call.params.query === "筛选企业").at(-1)?.params).toMatchObject({ offset: "0", limit: "20", query: "筛选企业", merchant_only: "true" });

      await page.getByRole("button", { name: "读取企业工单" }).click();
      await page.getByText("SUP-F-1", { exact: true }).waitFor({ state: "visible" });
      const listReads = () => calls.filter(call => call.method === "ops.support.platform.tickets.list");
      expect(listReads().at(-1)?.params).toEqual({ target_workspace_id: "ws-support-filtered", limit: "20" });
      await page.getByRole("button", { name: "下一页工单" }).click();
      await page.getByText("SUP-F-2", { exact: true }).waitFor({ state: "visible" });
      expect(listReads().at(-1)?.params).toEqual({ target_workspace_id: "ws-support-filtered", limit: "20", cursor_json: JSON.stringify(cursor) });

      await page.getByRole("textbox", { name: "搜索支持企业" }).fill("另一企业");
      await page.getByRole("button", { name: "读取授权企业目录" }).click();
      await page.getByRole("combobox", { name: "选择支持目标企业" }).click();
      await page.getByText(/另一企业 · ws-support-other/).click();
      await page.getByRole("button", { name: "读取企业工单" }).click();
      await page.getByText("SUP-O-1", { exact: true }).waitFor({ state: "visible" });
      expect(listReads().at(-1)?.params).toEqual({ target_workspace_id: "ws-support-other", limit: "20" });
      expect(listReads().filter(call => call.params.target_workspace_id === "ws-support-other")).toHaveLength(1);
      expect(calls.some(call => /^ops\.support\.platform\.ticket\.(?:create|assign|transition|comment)$/u.test(call.method))).toBe(false);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
