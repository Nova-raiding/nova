import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

// Traverses OpsConsoleController → opsPageRegistry → CustomerDeliveryPage with
// local API fixtures. It is route wiring and tenant-selection evidence only;
// no shared or Demo customer data is read or written.
describe("customer delivery controller route journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-customer-delivery-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-customer-delivery-route-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/customer-delivery?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `import React from 'react'; import { createRoot } from 'react-dom/client'; import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx'; localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'fixture-token',actorId:'fixture-operator'})); createRoot(document.getElementById('root')).render(React.createElement(OpsConsoleController));`, { flag: "wx" });
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
    if (!address || typeof address === "string") throw new Error("Customer delivery route fixture did not bind");
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

  it("loads only after an explicit target selection and preserves or discards a dirty create draft by choice", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin) return route.fallback();
        unexpectedRequests.push(url.origin);
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname === "/api/mcp", async route => {
        const request = route.request().postDataJSON() as { id?: string | number | null; method: string; params?: Record<string, unknown> };
        const params = request.params ?? {};
        calls.push({ method: request.method, params });
        let result: unknown = null;
        if (request.method === "ops.session") {
          result = {
            actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"],
            workspace_granted: false, workbench: "platform", scope: { type: "platform" },
            capabilities: ["platform.summary.read", "customer.delivery.read", "customer.delivery.update", "workspace.directory.read"],
          };
        } else if (request.method === "ops.workspaces.list") {
          result = { items: [{ workspaceId: "ws-delivery-route", enterpriseName: "交付路由企业", status: "active" }], total: 1, offset: 0, limit: 100, hasMore: false };
        } else if (request.method === "ops.customer-delivery.list") {
          result = {
            items: [{ id: "delivery-route-row", companyName: "路由客户档案", paymentStatus: "paid", profile: true, integration: false, acceptance: false, training: false, revision: 1, videos: [] }],
            total: 1, offset: Number(params.offset), limit: Number(params.limit), hasMore: false,
            project_owner_options: [], support_owner_options: [],
          };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("region", { name: "客户交付" }).waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "ops.customer-delivery.list")).toHaveLength(0);
      const targetWorkspace = page.getByRole("combobox", { name: "客户交付目标企业工作区" });
      await targetWorkspace.click();
      await page.getByText("交付路由企业 · ws-delivery-route", { exact: true }).click();
      await page.getByText("路由客户档案", { exact: true }).waitFor({ state: "visible" });

      const listCalls = () => calls.filter(call => call.method === "ops.customer-delivery.list");
      expect(listCalls().length).toBeGreaterThan(0);
      expect(listCalls().every(call => call.params.target_workspace_id === "ws-delivery-route")).toBe(true);
      expect(listCalls().every(call => call.params.offset === "0" && call.params.limit === "20")).toBe(true);

      await page.getByRole("button", { name: "新建客户", exact: true }).click();
      const companyName = page.getByLabel("公司名称", { exact: true });
      await companyName.fill("待确认路由客户");
      const returnToRegistry = page.getByRole("button", { name: "返回客户建档", exact: true });
      await returnToRegistry.click();
      expect(await returnToRegistry.getAttribute("aria-expanded")).toBe("true");
      const confirmation = page.locator(".ant-modal:visible").filter({ hasText: "当前填写内容和勾选尚未保存" });
      await confirmation.getByRole("button", { name: "继续填写", exact: true }).click();
      expect(await companyName.inputValue()).toBe("待确认路由客户");
      await returnToRegistry.click();
      await page.locator(".ant-modal:visible").filter({ hasText: "当前填写内容和勾选尚未保存" })
        .getByRole("button", { name: "放弃并返回", exact: true }).click();
      await page.getByRole("button", { name: "新建客户", exact: true }).waitFor({ state: "visible" });
      expect(calls.some(call => call.method.startsWith("ops.customer-delivery.") && call.method !== "ops.customer-delivery.list")).toBe(false);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
