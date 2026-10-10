import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("OverviewPage OpsConsoleController route browser journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-overview-controller-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-overview-controller-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/overview?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'fixture-token', actorId: 'fixture-operator'}));
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
    if (!address || typeof address === "string") throw new Error("Overview controller browser listener did not bind");
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

  it("loads the platform directory through the authorized Overview route and renders the returned count", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    const rpcCalls: Array<{ method: string; params: Record<string, unknown>; workbench?: string }> = [];
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
        rpcCalls.push({ method, params: rpc.params ?? {}, workbench: request.headers()["x-ops-workbench"] });
        let result: unknown = null;
        if (method === "ops.session") result = {
          actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" }, capabilities: ["platform.summary.read", "workspace.directory.read"],
        };
        if (method === "ops.workspaces.list") result = {
          items: [
            { workspaceId: "ws-a", enterpriseName: "商家甲", status: "active" },
            { workspaceId: "ws-b", enterpriseName: "商家乙", status: "active" },
          ], total: 2, offset: 0, limit: 20,
        };
        if (method === "ops.stores.list") result = { items: [], total: 0, offset: 0, limit: 20 };
        if (method === "ops.growth.funnel") result = { counts: {}, totalEvents: 0 };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "平台运营实时概况" }).waitFor({ state: "visible" });
      await page.getByRole("article", { name: "已关联商家工作区：2 个" }).waitFor({ state: "visible" });
      expect(new URL(page.url()).pathname).toBe("/ops/overview");
      expect(new URL(page.url()).searchParams.get("workbench")).toBe("platform");
      const directoryRead = rpcCalls.find(call => call.method === "ops.workspaces.list");
      expect(directoryRead).toMatchObject({
        params: { offset: "0", limit: "20", merchant_only: "true" },
        workbench: "platform",
      });
      expect(rpcCalls.some(call => call.method.includes("create") || call.method.includes("update") || call.method.includes("delete"))).toBe(false);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
