import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

describe("CustomerDelivery controller training completion readback journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-training-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-delivery-training-route-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/customer-delivery?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'delivery-token',actorId:'delivery-operator'}));
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
    if (!address || typeof address === "string") throw new Error("Customer delivery training route fixture did not bind");
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

  it("records training completion once and reads the updated status from the selected workspace", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    let trained = false;
    const workspaceId = "ws-delivery-training-route";
    const record = {
      id: "delivery-training-route", companyName: "培训状态验收客户", paymentStatus: "paid", contractNo: "CD-TR-21",
      profile: true, integration: true, acceptance: true, training: false, trainingEvidenceRefs: ["asset:training-fixture"], revision: 6, videos: [],
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
            actor_id: "delivery-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["platform.summary.read", "customer.delivery.read", "customer.delivery.update", "workspace.directory.read"],
          };
        } else if (method === "ops.workspaces.list") {
          result = { items: [{ workspaceId, enterpriseName: "培训验收企业", status: "active" }], total: 1, offset: 0, limit: 100, hasMore: false };
        } else if (method === "ops.customer-delivery.list") {
          const archivedOnly = params.archived_only === "true";
          const items = archivedOnly ? [] : [{ ...record, training: trained, revision: trained ? 7 : 6 }];
          result = { items, total: items.length, offset: Number(params.offset), limit: Number(params.limit), hasMore: false, project_owner_options: [], support_owner_options: [] };
        } else if (method === "ops.customer-delivery.videos.list") {
          result = { items: [] };
        } else if (method === "ops.customer-delivery.training.complete") {
          expect(params).toMatchObject({ target_workspace_id: workspaceId, delivery_id: record.id, completed: "true", evidence_refs_json: JSON.stringify(["asset:training-fixture"]), expected_revision: "6" });
          trained = true;
          result = { ...record, workspaceId, training: true, revision: 7 };
        } else if (method === "ops.stores.list") {
          result = { items: [] };
        } else if (method === "ops.growth.funnel") {
          result = null;
        } else {
          unexpectedRequests.push(`unexpected RPC ${method}`);
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("region", { name: "客户交付" }).waitFor({ state: "visible" });
      const workspace = page.getByRole("combobox", { name: "客户交付目标企业工作区" });
      await workspace.click();
      await page.getByText("培训验收企业 · ws-delivery-training-route", { exact: true }).click();
      const customerRow = page.locator("#ops-main-content").getByRole("row").filter({ hasText: "培训状态验收客户" });
      await customerRow.waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "ops.customer-delivery.list").at(-1)?.params).toMatchObject({ target_workspace_id: workspaceId, offset: "0", limit: "20" });
      const training = customerRow.getByRole("combobox", { name: "培训状态验收客户客户培训状态", exact: true });
      expect(await customerRow.innerText()).toContain("未培训");
      await training.click();
      await training.press("ArrowDown");
      await training.press("Enter");
      await expect.poll(() => calls.filter(call => call.method === "ops.customer-delivery.training.complete").length).toBe(1);
      await expect.poll(() => customerRow.innerText()).toContain("已培训");
      const writes = calls.filter(call => call.method === "ops.customer-delivery.training.complete");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.params).toMatchObject({
        target_workspace_id: workspaceId, delivery_id: record.id, completed: "true",
        evidence_refs_json: JSON.stringify(["asset:training-fixture"]), expected_revision: "6",
      });
      expect(calls.filter(call => call.method === "ops.customer-delivery.list")).toHaveLength(2);
      expect(calls.filter(call => call.method.startsWith("ops.customer-delivery.")).every(call => call.params.target_workspace_id === workspaceId)).toBe(true);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
