import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown>; approvalToken?: string };

describe("RulesPage controller positive approval readback journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-rules-controller-approval-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-rules-controller-approval-${randomUUID()}`;
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
    if (!address || typeof address === "string") throw new Error("Rules approval route listener did not bind");
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

  it("checks a draft before approval, sends scoped revision evidence once, and reads the approved list back", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    let approved = false;
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
        calls.push({ method, params, approvalToken: request.headers()["x-rule-approval-token"] });
        let result: unknown = null;
        if (method === "ops.session") result = {
          actor_id: "rules-reviewer", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" },
          capabilities: ["platform.summary.read", "rule.read", "rule.update", "rule.publish.approve"],
        };
        else if (method === "ops.rules.public.sync.status") result = [];
        else if (method === "ops.rules.public.drafts.list") result = approved ? { items: [] } : { items: [draft] };
        else if (method === "ops.rules.public.drafts.get") result = detail(approved ? { ...draft, status: "active", revision: 8 } : draft);
        else if (method === "rule.status") { approved = true; result = { ...draft, status: "active", revision: 8 }; }
        else unexpectedRequests.push(`unexpected RPC ${method}`);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "规则中心" }).click();
      await page.getByRole("heading", { name: "平台规则" }).waitFor({ state: "visible" });
      await page.getByText("拼多多发货时限规则", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "查看拼多多发货时限规则审核详情" }).click();
      await page.getByLabel("审核原因").waitFor({ state: "visible" });
      await page.getByLabel("审核原因").fill("已核对官方依据与规则校验和");
      await page.getByLabel("审批凭证编号").fill("APR-RULE-207");
      await page.getByLabel("独立审批人").fill("second-reviewer");
      await page.getByLabel("审批时间").fill("2026-10-11T08:00:00.000Z");
      await page.getByLabel("规则审批凭证").fill("fixture-issued-token");
      expect(await page.getByRole("button", { name: "审批并激活" }).isEnabled()).toBe(true);
      expect(calls.filter(call => call.method === "rule.status")).toEqual([]);
      expect(calls.filter(call => call.method === "rule.approve.batch")).toEqual([]);

      await page.getByRole("button", { name: "审批并激活" }).click();
      await page.getByText("当前筛选范围内没有待审核公共规则草稿", { exact: true }).waitFor({ state: "visible" });
      const mutation = calls.filter(call => call.method === "rule.status");
      expect(mutation).toHaveLength(1);
      expect(mutation[0]).toMatchObject({
        params: {
          pack_id: "pdd-shipping", version: "1.2.0", status: "active", public_scope: "platform", platform: "pinduoduo",
          expected_revision: "7", reason: "已核对官方依据与规则校验和",
          approval_json: JSON.stringify({ approval_ref: "APR-RULE-207", approved_by: "second-reviewer", approved_at: "2026-10-11T08:00:00.000Z" }),
        },
        approvalToken: "fixture-issued-token",
      });
      const draftListReads = calls.filter(call => call.method === "ops.rules.public.drafts.list");
      expect(draftListReads.length).toBeGreaterThanOrEqual(2);
      expect(draftListReads.at(-1)?.params).toEqual({ limit: "20" });
      expect(calls.some(call => call.method === "rule.approve.batch")).toBe(false);
      expect(calls.some(call => call.method === "ops.rules.public.drafts.get" && call.params.pack_id === "pdd-shipping")).toBe(true);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);
});
