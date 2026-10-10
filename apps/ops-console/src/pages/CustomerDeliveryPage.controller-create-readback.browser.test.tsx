import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

// Real OpsConsoleController route and local JSON-RPC only. This verifies the
// operator's explicit workspace selection, required form feedback, submission
// contract and readback without using customer data or a remote service.
describe("CustomerDelivery controller create readback journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-create-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-delivery-create-route-${randomUUID()}`;
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
    if (!address || typeof address === "string") throw new Error("Customer delivery create route fixture did not bind");
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

  it("requires a deliberate workspace and required fields, then creates and reads a customer back", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const workspaceId = "ws-delivery-create-route";
    let created: Record<string, unknown> | undefined;
    let revision = 1;
    let profile: Record<string, unknown> | undefined;
    const checklistWrites: Record<string, unknown[]> = {};
    const readRecord = () => ({
      id: "delivery-create-route", workspaceId, companyName: "路由建档验收客户",
      contractNumber: "CREATE-2026-01", paymentStatus: "paid", contractRef: "asset:create-contract",
      projectOwner: "负责人甲", supportOwner: "售后乙", paymentDate: "2026-10-11",
      paymentEvidenceRefs: [], customerProfileStatus: profile ? "complete" : "incomplete",
      systemIntegrationStatus: checklistWrites.system_integration ? "complete" : "incomplete",
      functionalAcceptanceStatus: checklistWrites.functional_acceptance ? "complete" : "incomplete",
      trainingCompleted: false, revision, videos: [],
    });
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(baseUrl).origin) { unexpectedRequests.push(url.origin); await route.abort(); return; }
        if (url.pathname !== "/api/mcp") return route.fallback();
        const rpc = route.request().postDataJSON() as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        calls.push({ method, params });
        let result: unknown = null;
        if (method === "ops.session") result = {
          actor_id: "delivery-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" },
          capabilities: ["platform.summary.read", "customer.delivery.read", "customer.delivery.update", "workspace.directory.read"],
        };
        else if (method === "ops.workspaces.list") result = { items: [{ workspaceId, enterpriseName: "建档验收企业", status: "active" }], total: 1, offset: 0, limit: 100, hasMore: false };
        else if (method === "ops.customer-delivery.list") {
          expect(params.target_workspace_id).toBe(workspaceId);
          const items = created && profile && checklistWrites.system_integration && checklistWrites.functional_acceptance ? [readRecord()] : [];
          result = { items, total: items.length, offset: Number(params.offset), limit: Number(params.limit), hasMore: false, project_owner_options: [], support_owner_options: [] };
        } else if (method === "ops.customer-delivery.create") {
          expect(params).toMatchObject({ target_workspace_id: workspaceId, company_name: "路由建档验收客户" });
          created = readRecord(); result = created;
        } else if (method === "ops.customer-delivery.assets.upload") {
          expect(params).toMatchObject({ target_workspace_id: workspaceId, delivery_id: "delivery-create-route", purpose: "contract", name: "contract-route.pdf", mime_type: "application/pdf" });
          result = { assetRef: "asset:create-contract", name: "contract-route.pdf", mimeType: "application/pdf", sizeBytes: 32, scanStatus: "clean", ready: true };
        } else if (method === "ops.customer-delivery.update") {
          expect(params).toMatchObject({ target_workspace_id: workspaceId, delivery_id: "delivery-create-route", expected_revision: String(revision) });
          profile = JSON.parse(String(params.patch_json)); revision++; result = { ...readRecord(), ...profile, revision };
        } else if (method === "ops.customer-delivery.checklist.update") {
          expect(params.target_workspace_id).toBe(workspaceId);
          expect(params.expected_revision).toBe(String(revision));
          const key = String(params.checklist_key);
          checklistWrites[key] = JSON.parse(String(params.items_json)); revision++;
          result = { items: checklistWrites[key], revision };
        } else if (method === "ops.customer-delivery.videos.list") result = { items: [] };
        else if (method === "ops.stores.list") result = { items: [] };
        else if (method === "ops.growth.funnel") result = null;
        else unexpectedRequests.push(`unexpected RPC ${method}`);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("region", { name: "客户交付" }).waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "ops.customer-delivery.list")).toHaveLength(0);
      expect(await page.getByRole("button", { name: "新建客户" }).isDisabled()).toBe(true);
      await page.getByRole("combobox", { name: "客户交付目标企业工作区" }).click();
      await page.getByText("建档验收企业 · ws-delivery-create-route", { exact: true }).click();
      await page.getByRole("button", { name: "新建客户" }).click();
      await page.getByText(/系统接入 0\/\d+ 项；功能验收 0\/\d+ 项。全部勾选后才能创建客户。/).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "创建客户", exact: true }).click();
      await page.getByText("请输入公司名称", { exact: true }).waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "ops.customer-delivery.create")).toHaveLength(0);

      await page.getByLabel("公司名称", { exact: true }).fill("路由建档验收客户");
      await page.getByLabel("合同编号", { exact: true }).fill("CREATE-2026-01");
      const payment = page.locator(".customer-delivery-payment-select"); await payment.click(); await payment.press("ArrowDown"); await payment.press("Enter");
      await page.getByLabel("付款时间", { exact: true }).click(); await page.locator(".ant-picker-cell-today").click();
      await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({ name: "contract-route.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 local fixture") });
      await page.getByLabel("项目负责人", { exact: true }).fill("负责人甲");
      await page.getByLabel("售后负责人", { exact: true }).fill("售后乙");
      for (const checkbox of await page.locator(".customer-delivery-check-card-row .customer-delivery-check-item input[type=checkbox]").all()) await checkbox.check({ force: true });
      await page.getByRole("button", { name: "创建客户", exact: true }).click();
      await page.getByRole("cell", { name: "路由建档验收客户", exact: true }).waitFor({ state: "visible" });

      expect(calls.filter(call => call.method.startsWith("ops.customer-delivery.") && call.method !== "ops.customer-delivery.list").map(call => call.method)).toEqual([
        "ops.customer-delivery.create", "ops.customer-delivery.assets.upload", "ops.customer-delivery.update",
        "ops.customer-delivery.checklist.update", "ops.customer-delivery.checklist.update",
      ]);
      expect(calls.filter(call => call.method.startsWith("ops.customer-delivery.")).every(call => call.params.target_workspace_id === workspaceId)).toBe(true);
      expect(calls.filter(call => call.method === "ops.customer-delivery.list").length).toBeGreaterThanOrEqual(2);
      expect(profile).toMatchObject({ companyName: "路由建档验收客户", contractNumber: "CREATE-2026-01", contractRef: "asset:create-contract", projectOwner: "负责人甲", supportOwner: "售后乙", customerProfileStatus: "complete" });
      expect(checklistWrites.system_integration?.length).toBeGreaterThan(0);
      expect(checklistWrites.functional_acceptance?.length).toBeGreaterThan(0);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 120_000);
});
