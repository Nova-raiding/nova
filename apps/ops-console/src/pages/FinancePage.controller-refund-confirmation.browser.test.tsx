import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

// Exercises the production controller → registry → FinancePage path. The local
// fixture simulates provider readiness and intercepts the refund RPC; no payment
// provider, real order, or settlement service is contacted.
describe("FinancePage controller refund confirmation journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-finance-refund-controller-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-finance-refund-route-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/finance?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'finance-token',actorId:'finance-operator'}));
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
    if (!address || typeof address === "string") throw new Error("Finance refund controller browser listener did not bind");
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

  it("creates exactly one refund only after explicit confirmation", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const unexpectedWrites: string[] = [];
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(baseUrl).origin) {
          unexpectedRequests.push(url.origin);
          await route.abort();
          return;
        }
        if (url.pathname === "/api/healthz") {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { payment: { mode: "provider", provider_configured: true, effective: true, state: "enabled", reasons: [] } } }) });
          return;
        }
        if (!url.pathname.startsWith("/api/")) return route.fallback();
        if (url.pathname !== "/api/mcp") {
          unexpectedRequests.push(`${route.request().method()} ${url.pathname}`);
          await route.abort();
          return;
        }
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { rpc = route.request().postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        calls.push({ method, params });
        if (method !== "billing.refund" && /(?:refund|payment|settle|reconcile|allocate|receipt|update|create|delete|approve|revoke)/iu.test(method)) unexpectedWrites.push(method);
        let result: unknown = null;
        if (method === "ops.session") {
          result = {
            actor_id: "finance-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["platform.summary.read", "billing.workspace.read", "billing.refund.execute"],
          };
        } else if (method === "billing.refund") {
          result = { status: "refunded", order_id: params.order_id, refund_id: "refund-fixture-2026" };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "平台财务中心" }).waitFor({ state: "visible" });
      const orderId = "recharge-fixture-2026";
      const reason = "本地隔离旅程：客户退款核实单 QA-93";
      await page.getByPlaceholder("例如 recharge_...").fill(` ${orderId} `);
      await page.getByPlaceholder("填写工单号和退款依据").fill(` ${reason} `);
      await page.getByRole("button", { name: "创建退款", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: `确认对订单 ${orderId} 创建退款？`, exact: true });
      await confirmation.waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "billing.refund")).toHaveLength(0);
      await page.getByRole("button", { name: "确认退款", exact: true }).click();
      await page.getByText("退款流水已创建", { exact: true }).waitFor({ state: "visible" });
      const refundCalls = calls.filter(call => call.method === "billing.refund");
      expect(refundCalls).toHaveLength(1);
      expect(refundCalls[0]?.params).toEqual({ order_id: orderId, reason });
      expect(unexpectedWrites).toEqual([]);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
