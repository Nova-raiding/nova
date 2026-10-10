import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

describe("CustomerDelivery controller archive readback journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-archive-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-delivery-archive-route-${randomUUID()}`;
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
    if (!address || typeof address === "string") throw new Error("Customer delivery archive route fixture did not bind");
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

  it("archives the selected customer delivery and reads it back in the same workspace", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    let archived = false;
    let archiveAttempts = 0;
    const workspaceId = "ws-delivery-archive-route";
    const record = {
      id: "delivery-archive-route", companyName: "归档回读客户", paymentStatus: "paid",
      profile: true, integration: true, acceptance: true, training: true, revision: 6, videos: [],
    };
    const archivedRecord = { ...record, revision: 7, archivedAt: "2026-10-11T00:00:00.000Z" };
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
          result = { items: [{ workspaceId, enterpriseName: "归档回读企业", status: "active" }], total: 1, offset: 0, limit: 100, hasMore: false };
        } else if (method === "ops.customer-delivery.list") {
          const archivedOnly = params.archived_only === "true";
          const items = archivedOnly ? (archived ? [archivedRecord] : []) : (archived ? [] : [record]);
          result = { items, total: items.length, offset: Number(params.offset), limit: Number(params.limit), hasMore: false, project_owner_options: [], support_owner_options: [] };
        } else if (method === "ops.customer-delivery.videos.list") {
          result = { items: [] };
        } else if (method === "ops.customer-delivery.update") {
          const patch = JSON.parse(String(params.patch_json)) as { archivedAt?: string };
          expect(params).toMatchObject({ target_workspace_id: workspaceId, delivery_id: record.id, expected_revision: "6" });
          expect(typeof patch.archivedAt).toBe("string");
          archiveAttempts++;
          if (archiveAttempts === 1) {
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: "TEMPORARY_FAILURE", message: "暂时无法保存，请重试" } }) });
            return;
          }
          archived = true;
          result = archivedRecord;
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
      await page.getByText("归档回读企业 · ws-delivery-archive-route", { exact: true }).click();
      const customerRow = page.locator("#ops-main-content").getByRole("cell", { name: "归档回读客户", exact: true });
      await customerRow.waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "ops.customer-delivery.list").at(-1)?.params).toMatchObject({ target_workspace_id: workspaceId, offset: "0", limit: "20" });

      await page.getByRole("button", { name: "查看详情", exact: true }).click();
      await page.getByRole("button", { name: "停用并删除记录", exact: true }).click();
      await page.getByRole("button", { name: "确认停用并删除", exact: true }).click();
      // antd closes the confirmation when its async handler rejects; the
      // details drawer remains open and carries the actionable error state.
      await page.getByRole("button", { name: "确认停用并删除", exact: true }).waitFor({ state: "detached" });
      await page.getByRole("alert").filter({ hasText: "暂时无法保存，请重试" }).waitFor({ state: "visible" });
      expect(archiveAttempts).toBe(1);
      // Retry from the still-open details drawer. This must use the same
      // record/revision and only archive once the second write succeeds.
      await page.getByRole("button", { name: "停用并删除记录", exact: true }).click();
      await page.getByRole("button", { name: "确认停用并删除", exact: true }).click();
      await customerRow.waitFor({ state: "detached" });
      expect(calls.filter(call => call.method === "ops.customer-delivery.update")).toHaveLength(2);
      expect(calls.filter(call => call.method === "ops.customer-delivery.list").at(-1)?.params).toMatchObject({ target_workspace_id: workspaceId, offset: "0", limit: "20" });

      await page.getByLabel("查看已归档记录").check();
      await customerRow.waitFor({ state: "visible" });
      const archivedRead = calls.filter(call => call.method === "ops.customer-delivery.list").at(-1);
      expect(archivedRead?.params).toMatchObject({ target_workspace_id: workspaceId, archived_only: "true", offset: "0", limit: "20" });
      expect(calls.filter(call => call.method.startsWith("ops.customer-delivery.")).every(call => call.params.target_workspace_id === workspaceId)).toBe(true);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
