import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

// This route journey traverses the real controller, page registry,
// authorization projection, SupportRoute, page, and platform support client.
// RPC results are local fixtures; this is not Demo tenant evidence.
describe("platform support reply controller route journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-support-reply-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-support-reply-route-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/overview?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'fixture-token',actorId:'fixture-operator'}));
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
    if (!address || typeof address === "string") throw new Error("Support route test listener did not bind");
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

  it("records an explicitly customer-visible reply for the selected enterprise and ticket", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const ticket = {
      id: "support-reply-ticket", workspaceId: "ws-support-reply", ticketNumber: "SUP-84",
      subject: "生成结果入口咨询", description: "购买前咨询如何查看生成结果。",
      status: "open", priority: "normal", customerId: "customer-84", customerName: "回复旅程客户",
      tags: ["handoff"], revision: 3, createdBy: "merchant-user",
      createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
    };
    const replyBody = "请打开工作台中的生成记录查看结果；如仍无法访问，请回复此工单。";
    const replyEvent = {
      id: "support-reply-event", workspaceId: "ws-support-reply", ticketId: ticket.id,
      sequence: 2, eventType: "commented", actorId: "fixture-operator", idempotencyKey: "support_reply_fixture_001",
      payload: { body: replyBody, visibility: "customer", expectedRevision: 3 }, createdAt: "2026-10-11T00:00:00.000Z",
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
        catch { await route.fulfill({ status: 400, body: "malformed fixture RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        calls.push({ method, params });
        let result: unknown = null;
        if (method === "ops.session") {
          result = {
            actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["platform.summary.read", "support.ticket.read", "support.ticket.update", "workspace.directory.read"],
          };
        } else if (method === "ops.workspaces.list") {
          result = { items: [{ workspaceId: "ws-support-reply", enterpriseName: "回复旅程企业", status: "active", planName: "test", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 0, subscriptionStatus: "active", memberCount: 1 }], total: 1, offset: 0, limit: 20, hasMore: false };
        } else if (method === "ops.support.platform.tickets.list") {
          result = { items: [ticket] };
        } else if (method === "ops.support.platform.ticket.get") {
          result = { ticket, events: [] };
        } else if (method === "ops.support.platform.ticket.comment") {
          const event = { ...replyEvent, idempotencyKey: String(params.idempotency_key), payload: { body: String(params.body), visibility: String(params.visibility), expectedRevision: Number(params.expected_revision) } };
          result = { ticket: { ...ticket, revision: 4, updatedAt: replyEvent.createdAt }, event, replayed: false };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "客服工作台" }).click();
      await page.getByRole("heading", { name: "客服工作台" }).waitFor();
      await page.getByRole("button", { name: "读取授权企业目录" }).click();
      await page.getByRole("combobox", { name: "选择支持目标企业" }).click();
      await page.getByText(/回复旅程企业 · ws-support-reply/).click();
      await page.getByRole("button", { name: "读取企业工单" }).click();
      await page.getByText("SUP-84", { exact: true }).waitFor();
      await page.getByRole("button", { name: "查看 SUP-84" }).click();
      await page.getByText("购买前咨询如何查看生成结果。", { exact: true }).waitFor();
      await page.getByLabel("平台回复可见范围").click();
      await page.getByText("客户可见回复", { exact: true }).last().click();
      await page.getByLabel("平台支持回复正文").fill(replyBody);
      await page.getByRole("button", { name: "预览真实工单回复" }).click();
      await page.getByText("核对回复后确认", { exact: true }).waitFor();
      await page.getByText("企业 ws-support-reply；原工单 support-reply-ticket；版本 3；客户可见回复", { exact: true }).waitFor();
      await page.getByRole("button", { name: "确认记录客户可见回复" }).click();
      await page.getByRole("status").getByText("真实工单回复已记录；可见范围以事件中的客户可见/内部标记为准。", { exact: true }).waitFor();
      await page.getByText(replyBody, { exact: true }).waitFor();
      const replyCalls = calls.filter(call => call.method === "ops.support.platform.ticket.comment");
      expect(replyCalls).toHaveLength(1);
      expect(replyCalls[0]?.params).toMatchObject({
        target_workspace_id: "ws-support-reply", ticket_id: "support-reply-ticket", body: replyBody,
        visibility: "customer", expected_revision: "3",
      });
      expect(replyCalls[0]?.params.idempotency_key).toMatch(/^support_reply_[0-9a-f-]{36}$/u);
      expect(calls.some(call => call.method.endsWith(".transition") || call.method.endsWith(".assign"))).toBe(false);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
