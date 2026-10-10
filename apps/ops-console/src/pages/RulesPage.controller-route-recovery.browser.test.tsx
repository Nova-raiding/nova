import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

describe("Rules controller route failure recovery", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-rules-controller-route-recovery-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-rules-controller-route-recovery-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/overview?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'rules-token',actorId:'rules-reviewer'}));
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
    if (!address || typeof address === "string") throw new Error("Rules controller route-recovery listener did not bind");
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

  it("retries a failed detail read and preserves the explicit rejection reason after a recoverable write failure", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    let rejected = false;
    let detailReads = 0;
    let statusWrites = 0;
    const draft = {
      id: "draft-shipping", platform: "pinduoduo", pack_id: "pdd-shipping", name: "拼多多发货时限规则", version: "1.2.0", status: "draft",
      source: { kind: "official", reference: "https://www.yangkeduo.com/home/help/example", checked_at: "2026-10-01T08:00:00.000Z", trust: "manual_pending_review" },
      checks: { dispatch_deadline_hours: 48 }, checksum: "c".repeat(64), checksum_valid: true,
      created_by: "rule-author", created_at: "2026-10-01T08:00:00.000Z", revision: 7,
    };
    const detail = (rule = draft) => ({ rule, audit: [] });
    try {
      page.on("pageerror", error => browserErrors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error" && !message.text().includes("[antd: Space] `direction` is deprecated")) browserErrors.push(message.text());
      });
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
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "fixture blocks non-RPC requests" }) });
          return;
        }
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { rpc = request.postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        calls.push({ method, params });
        if (method === "ops.session") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: {
          actor_id: "rules-reviewer", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" },
          capabilities: ["platform.summary.read", "rule.read", "rule.update", "rule.publish.approve"],
        } }) });
        if (method === "ops.rules.public.sync.status") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: [] }) });
        if (method === "ops.rules.public.drafts.list") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: rejected ? { items: [] } : { items: [draft] } }) });
        if (method === "ops.rules.public.drafts.get") {
          detailReads += 1;
          if (detailReads === 1) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32000, message: "规则详情暂时不可用" } }) });
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: detail(rejected ? { ...draft, status: "inactive", revision: 8 } : draft) }) });
        }
        if (method === "rule.status") {
          statusWrites += 1;
          if (statusWrites === 1) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32000, message: "规则服务暂时不可用，请确认状态后重试" } }) });
          rejected = true;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: { ...draft, status: "inactive", revision: 8 } }) });
        }
        unexpectedRequests.push(`unexpected RPC ${method} ${JSON.stringify(params)}`);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: null }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "规则中心" }).click();
      await page.getByRole("heading", { name: "平台规则" }).waitFor({ state: "visible" });
      await page.getByText("拼多多发货时限规则", { exact: true }).waitFor({ state: "visible" });
      const openDetail = page.getByRole("button", { name: "查看拼多多发货时限规则审核详情" });
      await openDetail.click();
      await page.getByText("规则详情暂时不可用").waitFor({ state: "visible" });
      expect(await page.getByRole("button", { name: "重试读取详情" }).isVisible()).toBe(true);
      expect(calls.filter(call => call.method === "rule.status")).toHaveLength(0);

      await page.getByRole("button", { name: "重试读取详情" }).click();
      const reasonField = page.getByLabel("审核原因");
      await reasonField.waitFor({ state: "visible" });
      expect(detailReads).toBe(2);
      await page.getByRole("button", { name: "关闭拼多多发货时限规则审核详情" }).click();
      expect(await openDetail.evaluate(node => node === document.activeElement)).toBe(true);
      await openDetail.click();
      await reasonField.waitFor({ state: "visible" });
      await reasonField.fill("官方依据已失效，拒绝入库");
      const rejectButton = page.getByRole("button", { name: "拒绝并归档", exact: true });
      await rejectButton.click();
      await page.getByText("规则服务暂时不可用，请确认状态后重试").waitFor({ state: "visible" });
      expect(await reasonField.inputValue()).toBe("官方依据已失效，拒绝入库");
      expect(statusWrites).toBe(1);
      expect(rejected).toBe(false);
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "拒绝并归档" && !button.disabled));
      await rejectButton.waitFor({ state: "visible" });
      expect(await rejectButton.count()).toBe(1);
      expect(await rejectButton.isEnabled()).toBe(true);

      await rejectButton.click();
      await page.getByText("当前筛选范围内没有待审核公共规则草稿", { exact: true }).waitFor({ state: "visible" });
      expect(statusWrites).toBe(2);
      expect(detailReads).toBe(5);
      expect(calls.filter(call => call.method === "rule.status").map(call => call.params)).toEqual([
        expect.objectContaining({ pack_id: "pdd-shipping", version: "1.2.0", status: "inactive", public_scope: "platform", platform: "pinduoduo", expected_revision: "7", reason: "官方依据已失效，拒绝入库" }),
        expect.objectContaining({ pack_id: "pdd-shipping", version: "1.2.0", status: "inactive", public_scope: "platform", platform: "pinduoduo", expected_revision: "7", reason: "官方依据已失效，拒绝入库" }),
      ]);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);
});
