import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("FinancePage search recovery", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  const entry = "/__finance-page-recovery-entry.tsx";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-finance-page-recovery-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    vite = await createServer({
      configFile: false,
      root: opsRoot,
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: { "import.meta.env.VITE_API_BASE": JSON.stringify("/api") },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "finance-page-recovery-test",
        resolveId(id) { if (id === entry) return `\0${entry}`; },
        load(id) {
          if (id !== `\0${entry}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { createAuthorizationProjection } from '/src/authz/authorization.ts';
            import { FinancePage } from '/src/pages/FinancePage.tsx';
            const session = { actor_id: 'fixture-operator', workspace_id: '', roles: ['platform_ops'], workbench: 'platform', scope: { type: 'platform' }, capabilities: ['billing.platform.read'] };
            const model = {
              opsSession: session,
              authorization: createAuthorizationProjection(session, true),
              workspaceRows: [], loading: false,
              load: async () => undefined,
              loadRechargeOrders: async () => undefined,
            };
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'fixture-token', actorId: 'fixture-operator' }));
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(FinancePage, { model, onNavigate: () => undefined })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__finance-page-recovery") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(output);
            }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Finance page test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("keeps the submitted keyword and retries a failed page search without claiming zero records", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(10_000);
    const unexpectedRequests: string[] = [];
    const searchCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin) return route.fallback();
        unexpectedRequests.push(url.origin);
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname.startsWith("/api/"), async route => {
        const request = route.request();
        if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/mcp") {
          unexpectedRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "fixture blocks unexpected API calls" }) });
          return;
        }
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { rpc = request.postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        if (rpc.method !== "ops.finance.search") {
          unexpectedRequests.push(rpc.method ?? "missing RPC method");
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "fixture blocks unexpected RPC calls" }) });
          return;
        }
        searchCalls.push({ method: rpc.method, params: rpc.params ?? {} });
        const response = searchCalls.length === 2
          ? { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32001, message: "财务检索服务暂时不可用" } }
          : { jsonrpc: "2.0", id: rpc.id ?? null, result: {
            records: searchCalls.length === 1 ? [{
              id: "record-1", kind: "recharge_order", workspaceId: "ws-1", status: "paid",
              occurredAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z",
              version: "v1", label: "旧筛选充值", redacted: true,
            }] : [],
            summary: {
              totalRecords: searchCalls.length === 1 ? 1 : 0, rechargeOrderCny: 10, subscriptionOrderCny: 0,
              subscriptionOrderWorkspaceCount: 0, subscriptionOrderBySku: {},
              walletCreditCny: 0, walletDebitCny: 0, walletNetCny: 0,
              providerCostCny: 0, customerChargeCny: 10, usageUnits: 0,
              byKind: { recharge_order: 1, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 },
            },
            snapshotAt: searchCalls.length === 1 ? "2026-10-09T00:00:00.000Z" : "2026-10-10T00:00:00.000Z",
            scope: { role: "platform_ops", workspaceCount: 1 },
          } };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
      });

      await page.goto(`${baseUrl}/__finance-page-recovery`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("heading", { name: "平台财务中心" }).waitFor();
      try { await page.getByText("record-1", { exact: true }).waitFor(); }
      catch (cause) {
        const body = await page.locator("body").innerText();
        throw new Error(`Finance initial snapshot did not load: ${JSON.stringify({ body, searchCalls, unexpectedRequests })}`, { cause });
      }
      await page.getByLabel("关键词").fill("  order-42  ");
      await page.locator('form[aria-label="财务检索筛选"] button[type="submit"]').click();

      const searchError = page.getByRole("alert").filter({ hasText: "财务检索失败" });
      try { await searchError.waitFor({ state: "visible" }); }
      catch (cause) {
        const runtime = await page.evaluate(() => ({
          title: document.querySelector("h2")?.textContent,
          body: document.body.innerText.slice(0, 5000),
          alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
        }));
        throw new Error(`Finance search failure feedback was not rendered: ${JSON.stringify({ runtime, searchCalls, unexpectedRequests })}`, { cause });
      }
      try { await page.getByText("本次检索失败，以下仍是上次成功快照", { exact: true }).waitFor(); }
      catch (cause) {
        const body = await page.locator("body").innerText();
        throw new Error(`Finance failed-search snapshot context was not rendered: ${JSON.stringify({ body, searchCalls })}`, { cause });
      }
      await page.getByText("record-1", { exact: true }).waitFor();
      expect(await page.getByLabel("关键词").inputValue()).toBe("  order-42  ");
      await searchError.getByRole("button", { name: "重试财务检索" }).click();
      await page.getByText("当前筛选条件下没有财务记录", { exact: true }).waitFor();

      expect(searchCalls).toEqual([
        { method: "ops.finance.search", params: { limit: "20" } },
        { method: "ops.finance.search", params: { text: "order-42", limit: "20" } },
        { method: "ops.finance.search", params: { text: "order-42", limit: "20" } },
      ]);
      expect(unexpectedRequests).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
