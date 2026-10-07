import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

// End-to-end UI orchestration proof only. Every RPC is fulfilled locally;
// no API, database, provider, production or demo host is contacted.
describe("Ops customer delivery create flow (local RPC fixture)", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(joinPath(tmpdir(), "ops-customer-create-flow-"));
    const entry = "/__customer-create-flow-module.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("password"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("production"),
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "customer-create-flow-test-entry",
        resolveId(id) { if (id === entry) return `\0${entry}`; },
        load(id) {
          if (id !== `\0${entry}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { CustomerDeliveryPage } from '/src/pages/CustomerDeliveryPage.tsx';
            import { UnsavedChangesProvider } from '/src/components/authz/UnsavedChangesContext.tsx';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            function Harness() {
              const [workspace, setWorkspace] = useState('');
              const model = {
                authorization: { can: capability => ['customer.delivery.read','customer.delivery.update','workspace.directory.read'].includes(capability) },
                authorizationTargetWorkspaceId: workspace,
                setAuthorizationTargetWorkspaceId: setWorkspace,
                loadWorkspaceDirectory: async () => {}, workspaceDirectoryLoading: false,
                workspaceRows: [{ workspaceId: 'ws-flow-demo', enterpriseName: '流程验收商家', status: 'active' }],
              };
              return React.createElement(UnsavedChangesProvider, null,
                React.createElement(App, null, React.createElement(CustomerDeliveryPage, { model })));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__customer-create-flow-page")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Local test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("selects a workspace, creates a draft, uploads contract, saves profile and both checklists, then reads the customer back", async () => {
    const page = await browser!.newPage();
    const calls: Array<{ method: string; params: Record<string, string> }> = [];
    const browserErrors: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", entry => { if (entry.type() === "error") browserErrors.push(entry.text()); });
    let revision = 1;
    let saved: Record<string, unknown> | undefined;
    const checklists: Record<string, unknown[]> = {};
    const draft = () => ({
      id: "delivery-flow-1", companyName: "流程验收商家", paymentStatus: "paid",
      customerProfileStatus: saved ? "complete" : "incomplete",
      systemIntegrationStatus: checklists.system_integration ? "complete" : "incomplete",
      functionalAcceptanceStatus: checklists.functional_acceptance ? "complete" : "incomplete",
      trainingCompleted: false, revision, ...(saved ?? {}),
    });
    await page.route(`${baseUrl}/api/mcp`, async route => {
      const req = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
      calls.push({ method: req.method, params: req.params });
      const { method, params } = req;
      let result: unknown;
      if (method === "ops.customer-delivery.list") result = {
        items: saved && checklists.system_integration && checklists.functional_acceptance ? [draft()] : [],
        total: saved && checklists.system_integration && checklists.functional_acceptance ? 1 : 0,
        offset: Number(params.offset), limit: Number(params.limit), hasMore: false,
        project_owner_options: ["负责人甲"], support_owner_options: ["售后乙"],
      };
      else if (method === "ops.customer-delivery.create") result = { ...draft(), revision: 1 };
      else if (method === "ops.customer-delivery.assets.upload") result = {
        assetRef: "asset:contract-flow", name: params.name, mimeType: params.mime_type,
        sizeBytes: 32, scanStatus: "clean", ready: true,
      };
      else if (method === "ops.customer-delivery.update") {
        expect(params.target_workspace_id).toBe("ws-flow-demo");
        expect(params.expected_revision).toBe(String(revision));
        saved = JSON.parse(params.patch_json!);
        revision++;
        result = { ...draft(), ...saved, revision };
      }
      else if (method === "ops.customer-delivery.checklist.update") {
        expect(params.target_workspace_id).toBe("ws-flow-demo");
        expect(params.expected_revision).toBe(String(revision));
        const key = params.checklist_key!;
        checklists[key] = JSON.parse(params.items_json!);
        revision++;
        result = { items: checklists[key], revision };
      }
      else return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "UNEXPECTED_RPC", message: `Unexpected local RPC: ${method}` } }) });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) });
    });

    // Browser must not escape the local test origin, even if app code gains a
    // new external asset/API request in the future.
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
      return route.fallback();
    });
    await page.goto(`${baseUrl}/__customer-create-flow-page`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const workspaceSelect = page.locator('[aria-label="客户交付目标企业工作区"]');
    if (!(await workspaceSelect.isVisible({ timeout: 8_000 }).catch(() => false))) {
      throw new Error(`Workspace selector missing. page=${(await page.locator("body").innerText()).slice(0, 1200)} errors=${browserErrors.join(" | ")}`);
    }
    await workspaceSelect.click();
    await page.getByText("流程验收商家 · ws-flow-demo", { exact: true }).click();
    await page.getByRole("button", { name: "新建客户" }).click();

    await page.getByLabel("公司名称", { exact: true }).fill("流程验收商家");
    await page.getByLabel("合同编号", { exact: true }).fill("CONTRACT-FLOW-01");
    const paymentSelect = page.locator(".customer-delivery-payment-select");
    await paymentSelect.click();
    await paymentSelect.press("ArrowDown");
    await paymentSelect.press("Enter");
    await page.getByLabel("付款时间", { exact: true }).click();
    await page.locator(".ant-picker-cell-today").click();
    await page.getByLabel("项目负责人", { exact: true }).fill("负责人甲");
    await page.getByLabel("售后负责人", { exact: true }).fill("售后乙");
    await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({ name: "contract-flow.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 local test contract fixture") });

    const checkRows = page.locator(".customer-delivery-check-card-row .customer-delivery-check-item");
    const checkCount = await checkRows.count();
    expect(checkCount).toBeGreaterThan(0);
    for (let index = 0; index < checkCount; index++) await checkRows.nth(index).locator("input[type=checkbox]").check({ force: true });
    await page.getByRole("button", { name: "创建客户" }).click();
    try {
      await page.getByRole("cell", { name: "流程验收商家", exact: true }).waitFor({ timeout: 15_000 });
    } catch {
      throw new Error(`Customer was not read back. RPCs=${calls.map(call => call.method).join(",")} page=${(await page.locator("body").innerText()).slice(-1800)} browserErrors=${browserErrors.join(" | ")}`);
    }

    expect(calls.map(call => call.method).filter(method => method !== "ops.customer-delivery.list")).toEqual([
      "ops.customer-delivery.create",
      "ops.customer-delivery.assets.upload",
      "ops.customer-delivery.update",
      "ops.customer-delivery.checklist.update",
      "ops.customer-delivery.checklist.update",
    ]);
    expect(calls.every(call => call.params.target_workspace_id === "ws-flow-demo")).toBe(true);
    expect(calls.filter(call => call.method === "ops.customer-delivery.list").length).toBeGreaterThanOrEqual(2);
    expect(saved).toMatchObject({ companyName: "流程验收商家", contractNumber: "CONTRACT-FLOW-01", contractRef: "asset:contract-flow", projectOwner: "负责人甲", supportOwner: "售后乙", customerProfileStatus: "complete" });
    expect(checklists.system_integration?.length).toBeGreaterThan(0);
    expect(checklists.functional_acceptance?.length).toBeGreaterThan(0);
    await page.close();
    }, 240_000);
});

function joinPath(...parts: string[]) { return parts.join("/"); }
