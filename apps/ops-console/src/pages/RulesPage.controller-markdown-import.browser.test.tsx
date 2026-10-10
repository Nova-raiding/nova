import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcCall = { method: string; params: Record<string, unknown> };

describe("RulesPage controller Markdown import journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessName = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-rules-controller-markdown-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-rules-controller-markdown-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/overview?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'',workbench:'platform',token:'rules-token',actorId:'rules-operator'}));
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
    if (!address || typeof address === "string") throw new Error("Rules Markdown route listener did not bind");
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

  it("uploads an approved-source Markdown card as a draft and reads it back in the review queue", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    const calls: RpcCall[] = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    let importedDraft: Record<string, unknown> | undefined;
    try {
      page.on("pageerror", error => browserErrors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error"
          && !message.text().includes("[antd: Space] `direction` is deprecated")
          && !message.text().includes("Instance created by `useForm` is not connected to any Form element")) browserErrors.push(message.text());
      });
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
        if (method === "ops.session") result = {
          actor_id: "rules-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" }, capabilities: ["platform.summary.read", "rule.read", "rule.update"],
        };
        else if (method === "ops.rules.public.sync.status") result = [];
        else if (method === "ops.rules.public.drafts.list") result = { items: importedDraft ? [importedDraft] : [] };
        else if (method === "rule.publish") {
          importedDraft = {
            id: "draft-markdown-001", platform: "pinduoduo", pack_id: params.pack_id, name: params.name,
            version: params.version, status: "draft",
            source: { kind: "official", reference: params.source_reference, checked_at: "2026-10-11T08:00:00.000Z", trust: "manual_pending_review" },
            checks: JSON.parse(String(params.checks_json)), checksum: "d".repeat(64), checksum_valid: true,
            created_by: "rules-operator", created_at: "2026-10-11T08:00:00.000Z", revision: 1,
          };
          result = { accepted: true };
        } else unexpectedRequests.push(`unexpected RPC ${method}`);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "规则中心" }).click();
      await page.getByRole("heading", { name: "平台规则" }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "上传平台规则（Markdown/ZIP）" }).click();
      const markdown = [
        "# 知识库 v1.4",
        "",
        "## PDD-001｜拼多多发货时限规则",
        "- 平台：拼多多",
        "- 官方依据：https://www.yangkeduo.com/home/help/example",
        "- 商品发货期限为 48 小时",
      ].join("\n");
      await page.locator('input[type="file"]').setInputFiles({ name: "pdd-rules.md", mimeType: "text/markdown", buffer: Buffer.from(markdown) });

      await page.getByRole("status").filter({ hasText: "规则草稿导入完成" }).waitFor({ state: "visible" });
      await page.getByText("拼多多发货时限规则", { exact: true }).waitFor({ state: "visible" });
      const publish = calls.filter(call => call.method === "rule.publish");
      expect(publish).toHaveLength(1);
      expect(publish[0]?.params).toMatchObject({
        pack_id: "pinduoduo-manual-pdd-001", name: "拼多多发货时限规则", version: "1.4",
        category: "platform", scope: "platform", source_kind: "internal",
        source_reference: "https://www.yangkeduo.com/home/help/example", status: "draft", public_scope: "platform", target_id: "pinduoduo",
      });
      expect(publish[0]?.params.reason).toContain("pdd-rules.md");
      expect(calls.filter(call => call.method === "ops.rules.public.drafts.list").length).toBeGreaterThanOrEqual(2);
      expect(await page.getByRole("button", { name: "审批并激活", exact: true }).count()).toBe(0);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);
});
