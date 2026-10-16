import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("StoragePage controller route recovery journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-storage-controller-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-storage-route-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/storage?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      import '/src/styles.css';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'storage-token', actorId: 'storage-operator'}));
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
    if (!address || typeof address === "string") throw new Error("Storage controller browser listener did not bind");
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

  it("shows storage read failure, retries platform scope, and reads back the workspace row", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    let reconciliationReads = 0;
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
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
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { rpc = request.postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        calls.push({ method, params });
        if (method === "ops.session") {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            jsonrpc: "2.0", id: rpc.id ?? null, result: {
              actor_id: "storage-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
              workbench: "platform", scope: { type: "platform" },
              capabilities: ["platform.summary.read", "storage.reconciliation.read", "workspace.summary.read"],
            },
          }) });
          return;
        }
        if (method === "ops.storage.reconciliation.list") {
          reconciliationReads += 1;
          if (reconciliationReads === 1) {
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32000, message: "对象存储对账暂时不可用" } }) });
            return;
          }
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: [{
            workspaceId: "workspace-northwind", status: "clean", runStatus: "succeeded", freshness: "fresh",
            lastRunAt: "2026-10-10T07:00:00.000Z",
            quota: { usedBytes: 4096, limitBytes: 65536, reservedBytes: 1024, projectedBytes: 5120 },
            counts: { references: 8, inventoryObjects: 8, matched: 8, missing: 0, metadataMismatches: 0, orphans: 0, crossWorkspace: 0, duplicates: 0 },
          }] }) });
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: null }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "存储与对账" }).waitFor({ state: "visible" });
      await page.getByText("对账结果加载失败", { exact: true }).waitFor({ state: "visible" });
      expect(reconciliationReads).toBe(1);
      const retry = page.getByRole("button", { name: "重试加载对账结果" });
      expect(await retry.count()).toBe(1);
      await retry.click();
      await page.getByText("workspace 对账列表（1）", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("工作区列表已读取", { exact: true }).waitFor({ state: "visible" });
      expect(await page.getByText("暂无可验证的对象清单对账结果", { exact: true }).count()).toBe(0);
      expect(await page.getByText("配额上限", { exact: true }).count()).toBe(0);
      await page.getByText("对账结果加载失败", { exact: true }).waitFor({ state: "detached" });
      expect(reconciliationReads).toBe(2);
      const storageCalls = calls.filter(call => call.method === "ops.storage.reconciliation.list");
      expect(storageCalls).toHaveLength(2);
      expect(storageCalls.map(call => call.params)).toEqual([{ platform_scope: "platform" }, { platform_scope: "platform" }]);
      const workspaceDetails = page.locator("details.ops-storage-workspace-details");
      await workspaceDetails.locator("summary").click();
      expect(await workspaceDetails.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true);
      const workspaceList = workspaceDetails.getByRole("list", { name: "workspace 存储对账状态" });
      expect(await workspaceList.getByRole("listitem").count()).toBe(1);
      const workspaceText = await workspaceList.innerText();
      expect(workspaceText).toContain("workspace-northwind");
      expect(workspaceText).toContain("正常");
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
      if (process.env.STORAGE_SCOPE_ARTIFACTS) {
        const directory = resolve(process.env.STORAGE_SCOPE_ARTIFACTS);
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: resolve(directory, "page.png"), fullPage: true });
        await writeFile(resolve(directory, "evidence.json"), JSON.stringify({ reconciliationReads, storageCalls, unexpectedRequests, browserErrors, bodyText: await page.locator("body").innerText() }, null, 2));
      }
    } finally { await page.close(); }
  }, 60_000);
});
