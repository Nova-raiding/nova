import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Ops controller identity route authorization", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(joinPath(tmpdir(), "ops-controller-identity-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-identity-route-${randomUUID()}`;
    const harnessHtml = join(appRoot, `${harnessName}.html`);
    const harnessEntry = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>window.__initialDomain = new URLSearchParams(location.search).get('route') || 'users'; history.replaceState(null, '', '/ops/' + window.__initialDomain + '?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(harnessEntry, `
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
    if (!address || typeof address === "string") throw new Error("Ops controller browser listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally { try { await vite?.close(); } finally {
      try { await Promise.all(harnessFiles.map(file => rm(file, { force: true }))); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    } }
  }, 60_000);

  it("keeps the denied deep route inert until refreshed session grants identity.read", async () => {
    if (!browser) throw new Error("Browser did not start");
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    let identityGranted = false;
    const rpcMethods: string[] = [];
    const restReads: string[] = [];
    const writeAttempts: string[] = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    const jsonModuleResponses: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
    page.on("requestfailed", request => browserErrors.push(`requestfailed ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`));
    page.on("response", response => {
      if (response.headers()["content-type"]?.includes("application/json") && response.url().includes("127.0.0.1")) {
        void response.text().then(body => jsonModuleResponses.push(`${response.status()} ${response.url()}: ${body.slice(0, 800)}`)).catch(() => undefined);
      }
    });
    try {
      // The fallback handler is registered first because Playwright evaluates
      // route handlers in reverse registration order. API-specific interception
      // below must get the request before this outbound-network guard.
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname === "127.0.0.1" && url.port === new URL(baseUrl).port) return route.fallback();
        unexpectedRequests.push(url.origin);
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname.startsWith("/api/"), async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/mcp") {
          let rpc: { id?: string | number | null; method?: string };
          try { rpc = request.postDataJSON() as typeof rpc; }
          catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
          const method = rpc.method ?? "";
          rpcMethods.push(method);
          if (!isReadMethod(method)) writeAttempts.push(method);
          const result = method === "ops.session" ? {
            actor_id: "fixture-operator", workspace_id: "", roles: [], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: identityGranted ? ["identity.read"] : [],
          } : method === "ops.users.list" ? {
            items: [], total: 0, identity_count: 0, workspace_count: 0, offset: 0, limit: 10, truncated: false,
          } : null;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
          return;
        }
        // RegistrationApplications performs a real GET after identity.read;
        // keep it fixture-backed, and fail closed on every REST write.
        if (request.method() !== "GET") {
          writeAttempts.push(`${request.method()} ${url.pathname}`);
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "fixture blocks writes" }) });
          return;
        }
        restReads.push(url.pathname);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0, limit: 20, offset: 0 }) });
      });
      const moduleResponses: string[] = [];
      page.on("response", response => {
        if (response.url().includes(`${harnessName}.tsx`)) moduleResponses.push(`${response.status()} ${response.headers()["content-type"] ?? "<no content-type>"} ${response.url()}`);
      });
      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      try { await page.getByRole("heading", { name: "无权访问“用户中心”" }).waitFor({ state: "visible", timeout: 8_000 }); }
      catch { await page.waitForTimeout(100); throw new Error(`Controller did not reach denied route. URL=${page.url()} module=${JSON.stringify(moduleResponses)} json=${JSON.stringify(jsonModuleResponses)} RPC=${JSON.stringify(rpcMethods)} errors=${JSON.stringify(browserErrors)} html=${(await page.locator("body").innerHTML()).slice(0, 1200)}`); }
      expect(rpcMethods).toEqual(["ops.session"]);
      expect(restReads).toEqual([]);
      expect(await page.getByRole("heading", { name: "用户目录" }).count()).toBe(0);

      identityGranted = true;
      await page.getByRole("button", { name: "刷新权限" }).click();
      await page.getByRole("heading", { name: "已接入用户" }).waitFor({ state: "visible" });
      await expectEventually(() => rpcMethods.filter(method => method === "ops.users.list").length === 1);
      expect(rpcMethods).toEqual(["ops.session", "ops.session", "ops.users.list"]);
      expect(writeAttempts).toEqual([]);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it.each([
    { routeDomain: "members", navLabel: "成员管理" },
    { routeDomain: "tasks", navLabel: "任务中心" },
    { routeDomain: "knowledge", navLabel: "知识治理" },
  ])("explains that $routeDomain is unavailable in the platform workbench and returns to an accessible route", async ({ routeDomain, navLabel }) => {
    if (!browser) throw new Error("Browser did not start");
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    const rpcMethods: string[] = [];
    const unexpectedRequests: string[] = [];
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname === "127.0.0.1" && url.port === new URL(baseUrl).port) return route.fallback();
        unexpectedRequests.push(url.origin);
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname.startsWith("/api/"), async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== "POST" || url.pathname !== "/api/mcp") {
          unexpectedRequests.push(`${request.method()} ${url.pathname}`);
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "fixture blocks unexpected requests" }) });
          return;
        }
        let rpc: { id?: string | number | null; method?: string };
        try { rpc = request.postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        rpcMethods.push(method);
        const result = method === "ops.session" ? {
          actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" }, capabilities: ["platform.summary.read"],
        } : null;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });
      await page.goto(`${baseUrl}/${harnessName}.html?route=${routeDomain}`, { waitUntil: "domcontentloaded" });
      const blocked = page.getByRole("status").filter({ hasText: "此页面需要商家工作区权限" });
      await blocked.waitFor({ state: "visible" });
      await expectEventually(() => page.url().includes(`/ops/${routeDomain}?workbench=platform`));
      await blocked.getByText("平台运营控制台不提供该页面").waitFor();
      expect(await blocked.getByRole("button", { name: "返回总览" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: navLabel, exact: true }).count()).toBe(0);
      expect(rpcMethods).toEqual(["ops.session"]);
      await blocked.getByRole("button", { name: "返回总览" }).click();
      await page.getByText("当前账号没有模型状态读取权限").waitFor();
      await expectEventually(() => page.url().includes("/ops/overview?workbench=platform"));
      expect(rpcMethods).toEqual(["ops.session"]);
      expect(unexpectedRequests).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

function isReadMethod(method: string): boolean {
  return method === "ops.session" || method.endsWith(".list") || method.endsWith(".get") || method.endsWith(".search") || method.endsWith(".summary");
}

async function expectEventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(predicate()).toBe(true);
}

function joinPath(...parts: string[]): string { return parts.join("/").replace(/\/+/gu, "/"); }

declare global {
  interface Window { __initialDomain: string; }
}
