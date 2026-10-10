import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

// Exercises the production controller and RulesPage using only a local RPC fixture.
describe("RulesPage controller batch approval cancellation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-rules-batch-cancel-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-rules-batch-cancel-${randomUUID()}`;
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
    if (!address || typeof address === "string") throw new Error("Rules controller browser listener did not bind");
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

  it("cancels a fully scoped two-rule batch review without issuing a write", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const drafts = [
      {
        id: "draft-delivery", platform: "pinduoduo", pack_id: "pdd-delivery", name: "拼多多发货时限草稿", version: "1.2.0", status: "draft",
        source: { kind: "official", reference: "https://www.yangkeduo.com/home/help/example", checked_at: "2026-10-01T08:00:00.000Z", trust: "manual_pending_review" },
        checks: { dispatch_deadline_hours: 48 }, checksum: "a".repeat(64), checksum_valid: true,
        created_by: "draft-author", created_at: "2026-10-01T08:00:00.000Z", revision: 3,
      },
      {
        id: "draft-image", platform: "pinduoduo", pack_id: "pdd-image", name: "拼多多图片规范草稿", version: "2.0.0", status: "draft",
        source: { kind: "official", reference: "https://www.yangkeduo.com/home/help/image", checked_at: "2026-10-02T08:00:00.000Z", trust: "manual_pending_review" },
        checks: { image_min_width: 800 }, checksum: "b".repeat(64), checksum_valid: true,
        created_by: "another-draft-author", created_at: "2026-10-02T08:00:00.000Z", revision: 5,
      },
    ];
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
            actor_id: "rules-reviewer", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["platform.summary.read", "rule.read", "rule.update", "rule.publish.approve"],
          };
        } else if (method === "ops.rules.public.sync.status") {
          result = [];
        } else if (method === "ops.rules.public.drafts.list") {
          result = { items: drafts };
        } else {
          unexpectedRequests.push(`unexpected RPC ${method}`);
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "规则中心" }).click();
      await page.getByRole("heading", { name: "平台规则" }).waitFor({ state: "visible" });
      await page.getByText("拼多多发货时限草稿", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("拼多多图片规范草稿", { exact: true }).waitFor({ state: "visible" });
      const deliveryRow = page.getByRole("row").filter({ hasText: "拼多多发货时限草稿" });
      const imageRow = page.getByRole("row").filter({ hasText: "拼多多图片规范草稿" });
      await deliveryRow.getByRole("checkbox").check();
      await imageRow.getByRole("checkbox").check();
      const openBatch = page.getByRole("button", { name: "一键审批选中（2）" });
      await openBatch.click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("一键审批选中的 2 条公共规则", { exact: true }).waitFor({ state: "visible" });
      await dialog.getByText("服务端会对每条规则分别校验 expected_revision、来源、独立审批凭证和创建人与审批人分离；任一条失败时整批回滚。", { exact: true }).waitFor({ state: "visible" });
      await dialog.getByLabel("批量审核原因").fill("已核对候选范围，暂不批准");
      await dialog.getByLabel("批量审批凭证编号").fill("APR-SCOPE-84");
      await dialog.getByLabel("批量独立审批人").fill("second-reviewer");
      await dialog.getByLabel("批量审批时间").fill("2026-10-11T08:00:00.000Z");
      await dialog.getByLabel("批量规则审批凭证").fill("local-fixture-token");
      await page.locator(".ant-modal-footer button").first().click();
      await dialog.waitFor({ state: "hidden" });
      expect(await page.getByRole("button", { name: "一键审批选中（2）" }).count()).toBe(1);
      expect(calls.filter(call => ["rule.approve.batch", "rule.status", "rule.approve"].includes(call.method))).toEqual([]);
      expect(calls.filter(call => call.method === "ops.rules.public.drafts.list").length).toBeGreaterThan(0);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 90_000);
});
