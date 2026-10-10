import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("UsersPage platform registration review route journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-users-registration-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-users-registration-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/users?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
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
    if (!address || typeof address === "string") throw new Error("Users registration controller browser listener did not bind");
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

  it("blocks unsupported approval writes and keeps rejection available", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const restCalls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    let reviewed = false;
    const application = () => ({
      application_id: "application-geo-17", login: "owner@example.test", enterprise_name: "Geo Retail",
      contact_name: "Lin", status: reviewed ? "rejected" : "merchant_pending", workspace_ids: [],
      created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-11T08:00:00.000Z", revision: reviewed ? 2 : 1,
    });
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
        const url = new URL(request.url());
        if (url.pathname === "/api/mcp" && request.method() === "POST") {
          let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
          try { rpc = request.postDataJSON() as typeof rpc; }
          catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
          const method = rpc.method ?? "";
          const params = rpc.params ?? {};
          rpcCalls.push({ method, params });
          let result: unknown = null;
          if (method === "ops.session") result = {
            actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["identity.read", "identity.update"],
          };
          else if (method === "ops.users.list") result = { items: [], total: 0, identityCount: 0, workspaceCount: 0, offset: 0, limit: 10, truncated: false };
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
          return;
        }
        let body: Record<string, unknown> | undefined;
        if (request.method() !== "GET") {
          try { body = request.postDataJSON() as Record<string, unknown>; }
          catch { unexpectedRequests.push(`malformed REST body ${request.method()} ${url.pathname}`); }
        }
        restCalls.push({ method: request.method(), path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
        if (request.method() === "GET" && url.pathname === "/api/v1/ops/merchant-registration-applications") {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { items: [application()], total: 1, limit: 20, offset: 0 } }) });
          return;
        }
        if (request.method() === "POST" && url.pathname === "/api/v1/ops/merchant-accounts/authorize") {
          await route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ error: {
            code: "MERCHANT_LEGACY_AUTHORIZATION_DISABLED",
            message: "旧账号授权接口已停止新建授权",
            next_actions: ["ops.commercial.order.preview", "ops.commercial.order.create", "ops.commercial.receipt.record"],
          } }) });
          return;
        }
        if (request.method() === "POST" && url.pathname === "/api/v1/ops/merchant-registration-applications/review") {
          reviewed = true;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { success: true, status: "rejected" } }) });
          return;
        }
        unexpectedRequests.push(`${request.method()} ${url.pathname}`);
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "fixture blocks unconfigured request" }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "已接入用户" }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: /更多用户治理操作/u }).click();
      await page.getByRole("menuitem", { name: "入驻申请", exact: true }).click();
      await page.getByText("入驻申请", { exact: true }).last().waitFor({ state: "visible" });
      const applicationRow = page.getByRole("row").filter({ hasText: "owner@example.test" });
      await applicationRow.waitFor({ state: "visible" });
      expect(await applicationRow.innerText()).toContain("待审核");
      const reviewButton = applicationRow.getByRole("button").filter({ hasText: /审\s*核/u });
      expect(await reviewButton.count(), `registration row buttons=${JSON.stringify(await applicationRow.getByRole("button").allTextContents())}; row=${await applicationRow.innerText()}`).toBe(1);
      await reviewButton.click();
      const drawer = page.getByRole("dialog", { name: "审核入驻申请 · Geo Retail" });
      await drawer.waitFor({ state: "visible" });
      expect(restCalls.filter(call => call.method === "POST")).toEqual([]);
      await drawer.getByText("通过审批暂不可用", { exact: true }).waitFor();
      await drawer.getByText(/旧授权接口返回 HTTP 410/u).waitFor();
      const reasonInput = drawer.getByPlaceholder("至少填写 4 个字符");
      await reasonInput.fill("资料仍需核验");
      expect(await drawer.getByRole("button", { name: "提交审核", exact: true }).isDisabled()).toBe(true);
      expect(restCalls.filter(call => call.method === "POST")).toEqual([]);

      await drawer.getByLabel("审核决定").click();
      await page.getByRole("option", { name: "拒绝", exact: true }).click();
      expect(await reasonInput.inputValue()).toBe("资料仍需核验");
      await drawer.getByRole("button", { name: "提交审核", exact: true }).click();
      await drawer.waitFor({ state: "hidden" });

      const authorize = restCalls.filter(call => call.method === "POST" && call.path === "/api/v1/ops/merchant-accounts/authorize");
      const review = restCalls.filter(call => call.method === "POST" && call.path === "/api/v1/ops/merchant-registration-applications/review");
      expect(authorize).toHaveLength(0);
      expect(review).toHaveLength(1);
      expect(review[0].body).toMatchObject({ login: "owner@example.test", decision: "rejected", workspace_ids: [] });
      expect(restCalls.filter(call => call.method === "GET" && call.path.startsWith("/api/v1/ops/merchant-registration-applications"))).toHaveLength(2);
      await page.getByRole("row").filter({ hasText: "owner@example.test" }).getByText("已拒绝", { exact: true }).waitFor({ state: "visible" });
      expect(rpcCalls.some(call => call.method === "ops.session")).toBe(true);
      expect(rpcCalls.every(call => call.method === "ops.session" || call.method === "ops.users.list")).toBe(true);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);
});
