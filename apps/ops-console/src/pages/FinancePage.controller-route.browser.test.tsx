import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

// Exercises the production controller → registry → FinancePage path. All finance
// responses are intercepted local fixtures; no payment/settlement write is made.
describe("FinancePage controller read-only route journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-finance-controller-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-finance-route-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/overview?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
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
    if (!address || typeof address === "string") throw new Error("Finance controller browser listener did not bind");
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

  it("filters platform finance records, retries a read-only detail, and preserves snapshot identity", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    let detailReads = 0;
    const snapshotAt = "2026-10-10T00:00:00.000Z";
    const row = {
      id: "invoice-84", kind: "recharge_order", enterpriseName: "Northwind", workspaceId: "ws-finance-84",
      status: "paid", label: "充值订单", reference: "pay-ref-84", amountCny: 88, occurredAt: snapshotAt,
      updatedAt: snapshotAt, version: "v3", redacted: true,
    };
    const summary = {
      totalRecords: 1, rechargeOrderCny: 88, subscriptionOrderCny: 0, subscriptionOrderWorkspaceCount: 0,
      subscriptionOrderBySku: {}, walletCreditCny: 0, walletDebitCny: 0, walletNetCny: 0,
      providerCostCny: 0, customerChargeCny: 88, usageUnits: 0,
      byKind: { recharge_order: 1, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 },
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
            actor_id: "finance-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["platform.summary.read", "billing.platform.read", "billing.export"],
          };
        } else if (method === "ops.finance.search") {
          const filtered = params.workspace_ids_json === JSON.stringify(["ws-finance-84"]);
          result = {
            records: filtered ? [row] : [], summary: filtered ? summary : { ...summary, totalRecords: 0, rechargeOrderCny: 0, customerChargeCny: 0, byKind: { ...summary.byKind, recharge_order: 0 } },
            snapshotAt, scope: { role: "platform_ops", workspaceCount: filtered ? 1 : 0 },
          };
        } else if (method === "ops.finance.detail") {
          detailReads += 1;
          if (detailReads === 1) {
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32000, message: "账单详情读取暂时不可用" } }) });
            return;
          }
          result = { ...row, attributes: { payment_provider: "alipay", order_id: "order-84" } };
        } else {
          unexpectedRequests.push(`unexpected RPC ${method}`);
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "账务与退款" }).click();
      await page.getByRole("heading", { name: "平台财务中心" }).waitFor({ state: "visible" });
      await page.getByLabel("关键词").fill("order-84");
      await page.getByLabel("Workspace ID").fill(" ws-finance-84, ");
      await page.locator('form[aria-label="财务检索筛选"] button[type="submit"]').click();
      await page.getByText("invoice-84", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "查看 充值订单 invoice-84 详情" }).click();
      const drawer = page.getByRole("dialog", { name: "财务详情 · 充值订单", exact: true });
      await drawer.getByRole("alert").getByText("账单详情读取暂时不可用", { exact: true }).waitFor({ state: "visible" });
      await drawer.getByRole("button", { name: "重试财务详情" }).click();
      await drawer.getByText("order-84", { exact: true }).waitFor({ state: "visible" });
      await drawer.getByText("¥88.00", { exact: true }).waitFor({ state: "visible" });
      expect(detailReads).toBe(2);
      const filteredSearch = calls.find(call => call.method === "ops.finance.search" && call.params.workspace_ids_json !== undefined);
      expect(filteredSearch?.params).toMatchObject({ workspace_ids_json: JSON.stringify(["ws-finance-84"]), text: "order-84", limit: "20" });
      expect(calls.filter(call => call.method === "ops.finance.detail").map(call => call.params)).toEqual([
        { target_workspace_id: "ws-finance-84", kind: "recharge_order", record_id: "invoice-84", expected_version: "v3", snapshot_at: snapshotAt },
        { target_workspace_id: "ws-finance-84", kind: "recharge_order", record_id: "invoice-84", expected_version: "v3", snapshot_at: snapshotAt },
      ]);
      expect(calls.some(call => /(?:refund|payment|settle|reconcile|allocate|receipt|update|create)/iu.test(call.method))).toBe(false);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
