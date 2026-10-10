import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

describe("Audit controller workspace scope transition", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-audit-scope-switch-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-audit-scope-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/overview?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'audit-token',actorId:'audit-operator'}));
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
    if (!address || typeof address === "string") throw new Error("Audit scope-switch browser listener did not bind");
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

  it("switches from one selected workspace to aggregate read-only without leaking the prior scope", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const record = {
      id: "audit-scope-1", source: "operation", workspaceId: "ws-scope-switch", actorId: "ops-user",
      action: "member.update", resourceType: "member", resourceId: "member-1",
      occurredAt: "2026-10-01T00:00:00.000Z", reason: "reviewed", redacted: true,
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
            actor_id: "audit-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["platform.summary.read", "audit.read", "audit.export", "workspace.directory.read"],
          };
        } else if (method === "ops.workspaces.list") {
          result = { items: [{ workspaceId: "ws-scope-switch", enterpriseName: "Scope Switch Ltd", status: "active", planName: "test", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 0, subscriptionStatus: "active", memberCount: 1 }], total: 1, offset: 0, limit: 20, hasMore: false };
        } else if (method === "ops.audit.list" || method === "ops.audit.platform.list") {
          result = { records: [record], totalRecords: 1, truncated: false };
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
      await page.getByRole("button", { name: "审计中心" }).click();
      await page.getByRole("heading", { name: "审计中心" }).waitFor({ state: "visible" });
      const workspaceSelect = page.getByRole("combobox", { name: "审计目标企业主体" });
      await workspaceSelect.click();
      await page.getByText("Scope Switch Ltd · ws-scope-switch", { exact: true }).click();
      await page.getByText("member.update", { exact: true }).waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "ops.audit.list").at(-1)?.params).toMatchObject({ workspace_id: "ws-scope-switch", limit: "20" });
      expect(await page.getByRole("button", { name: "导出当前筛选" }).isDisabled()).toBe(false);
      expect(await page.getByRole("button", { name: "查看审计事件 audit-scope-1 详情" }).isDisabled()).toBe(false);

      await workspaceSelect.click();
      await page.getByText("平台聚合（仅查看）", { exact: true }).click();
      await page.getByText("member.update", { exact: true }).waitFor({ state: "visible" });
      expect(calls.filter(call => call.method === "ops.audit.platform.list").length).toBeGreaterThanOrEqual(2);
      const aggregateRead = calls.filter(call => call.method === "ops.audit.platform.list").at(-1);
      expect(aggregateRead?.params).not.toHaveProperty("workspace_id");
      expect(await page.getByRole("button", { name: "导出当前筛选" }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "查看审计事件 audit-scope-1 详情" }).isDisabled()).toBe(true);
      expect(calls.some(call => call.method === "ops.audit.detail" || call.method === "ops.audit.export")).toBe(false);
      expect(calls.some(call => /\.(create|update|delete|mutate|write)$/iu.test(call.method))).toBe(false);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
