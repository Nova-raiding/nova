import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

// Exercises the production controller → registry → FinancePage export path.
// Search and export responses are local fixtures; no payment or settlement occurs.
describe("FinancePage controller filtered export journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-finance-export-controller-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-finance-export-route-${randomUUID()}`;
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
    if (!address || typeof address === "string") throw new Error("Finance export controller browser listener did not bind");
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

  it("exports the currently filtered platform finance snapshot as a local CSV download", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
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
        } else if (method === "ops.finance.export") {
          result = { exportId: "finance-export-fixture-84", fileName: "finance-filter-84.csv", contentType: "text/csv; charset=utf-8", csv: "type,id,workspace_id,status\n充值订单,invoice-84,ws-finance-84,paid\n", rowCount: 1, truncated: false, snapshotAt };
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
      const exportButton = page.locator("button").filter({ hasText: "导出当前筛选" });
      if (await exportButton.count() !== 1) throw new Error(`Export CTA missing; visible finance page:\n${await page.locator("body").innerText()}`);
      const [download] = await Promise.all([page.waitForEvent("download"), exportButton.click()]);
      expect(download.suggestedFilename()).toBe("finance-filter-84.csv");
      const downloadedPath = join(cacheDirectory, "finance-filter-84.csv");
      await download.saveAs(downloadedPath);
      expect(await readFile(downloadedPath, "utf8")).toBe("type,id,workspace_id,status\n充值订单,invoice-84,ws-finance-84,paid\n");
      await page.getByRole("status").getByText("财务导出完成：已导出 1 条记录。", { exact: true }).waitFor({ state: "visible" });
      const filteredSearch = calls.find(call => call.method === "ops.finance.search" && call.params.workspace_ids_json !== undefined);
      expect(filteredSearch?.params).toMatchObject({ workspace_ids_json: JSON.stringify(["ws-finance-84"]), text: "order-84", limit: "20" });
      const exports = calls.filter(call => call.method === "ops.finance.export");
      expect(exports).toHaveLength(1);
      expect(exports[0]?.params).toEqual({ workspace_ids_json: JSON.stringify(["ws-finance-84"]), text: "order-84", snapshot_at: snapshotAt, limit: "20" });
      expect(calls.some(call => /(?:refund|payment|settle|reconcile|allocate|receipt|update|create|delete|approve|revoke)/iu.test(call.method))).toBe(false);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
