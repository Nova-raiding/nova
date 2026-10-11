import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Knowledge component recovery and protected/retired route boundaries", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-knowledge-route-recovery-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-knowledge-route-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>const params=new URLSearchParams(location.search);window.__renderKnowledgeComponent=params.get('component')==='knowledge';const domain=params.get('route')||'knowledge';const workbench=params.get('workbench')||'workspace';history.replaceState(null,'','/ops/'+domain+'?workbench='+workbench)</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App, Form } from 'antd';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      import { KnowledgePage } from '/src/pages/KnowledgePage.tsx';
      function KnowledgeComponentHarness() {
        const [failed, setFailed] = React.useState(true);
        const [ruleForm] = Form.useForm();
        const [assetForm] = Form.useForm();
        const [competitorForm] = Form.useForm();
        const model = {
          loading:false,
          dataSetError:(...methods) => failed && methods.includes('knowledge.learning.list') ? '知识学习服务暂时不可用' : undefined,
          load:async () => { window.__knowledgeLoadCount=(window.__knowledgeLoadCount||0)+1; setFailed(false); },
          knowledgeRules:failed?undefined:[], knowledgeAssets:failed?undefined:[], learningSuggestions:failed?undefined:[], competitors:failed?undefined:[],
          canRules:false, canKnowledge:false, canCompetitor:false,
          knowledgeRuleForm:ruleForm, knowledgeAssetForm:assetForm, competitorForm,
          createKnowledgeRule:async()=>{}, updateKnowledgeRule:async()=>{}, createKnowledgeAsset:async()=>{}, updateKnowledgeAsset:async()=>{},
          createCompetitor:async()=>{}, confirmLearning:async()=>{}, dismissLearning:async()=>{}, updateBrandPreference:async()=>{},
        };
        return React.createElement(App,null,React.createElement(KnowledgePage,{model}));
      }
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase:'/api',workspaceId:'ws-knowledge-route',workbench:'workspace',token:'fixture-token',actorId:'fixture-operator'}));
      createRoot(document.getElementById('root')).render(window.__renderKnowledgeComponent ? React.createElement(KnowledgeComponentHarness) : React.createElement(OpsConsoleController));
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
    if (!address || typeof address === "string") throw new Error("Knowledge route browser listener did not bind");
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

  it("renders KnowledgePage with its real unmocked section, announces an unread dataset, and recovers on retry", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    const unexpectedRequests: string[] = [];
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin) return route.fallback();
        unexpectedRequests.push(url.origin);
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname === "/api/mcp", async route => {
        let rpc: { id?: string | number | null; method?: string };
        try { rpc = route.request().postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        unexpectedRequests.push(`unexpected RPC ${rpc.method ?? "<missing method>"}`);
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "component fixture has no API access" }) });
      });
      await page.goto(`${baseUrl}/${harnessName}.html?component=knowledge`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "知识库", exact: true }).waitFor({ state: "visible" });
      await page.getByText("知识库内容与治理", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("alert").filter({ hasText: "知识学习服务暂时不可用" }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "重试加载运营数据" }).click();
      await page.getByRole("alert").filter({ hasText: "知识学习服务暂时不可用" }).waitFor({ state: "hidden" });
      await page.getByRole("tab", { name: "学习建议（0）" }).waitFor({ state: "visible" });
      expect(await page.getByRole("heading", { name: "知识库", exact: true }).count()).toBe(1);
      expect(await page.getByText("工作区规则", { exact: true }).count()).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.__knowledgeLoadCount)).toBe(1);
      expect(unexpectedRequests).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("blocks the workspace-only Knowledge deep link in the platform Controller and returns to Overview", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    const methods: string[] = [];
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin) return route.fallback();
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname === "/api/mcp", async route => {
        let rpc: { id?: string | number | null; method?: string };
        try { rpc = route.request().postDataJSON() as typeof rpc; }
        catch { await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        methods.push(method);
        const result = method === "ops.session" ? {
          actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" }, capabilities: ["platform.summary.read"],
        } : null;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });
      await page.goto(`${baseUrl}/${harnessName}.html?route=knowledge&workbench=platform`, { waitUntil: "domcontentloaded" });
      const blocked = page.getByRole("status").filter({ hasText: "平台运营控制台不提供此页面" });
      await blocked.waitFor({ state: "visible" });
      await blocked.getByText("属于商家工作区，平台运营控制台不提供该页面。", { exact: false }).waitFor();
      expect(await page.getByRole("heading", { name: "知识库", exact: true }).count()).toBe(0);
      expect(methods.some(method => method.startsWith("knowledge."))).toBe(false);
      await blocked.getByRole("button", { name: "返回总览" }).click();
      await page.getByRole("main", { name: "总览" }).waitFor({ state: "visible" });
      expect(new URL(page.url()).pathname).toBe("/ops/overview");
    } finally { await page.close(); }
  }, 60_000);

  it("canonicalizes the unregistered Incidents deep link to Overview without mounting an incident route", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    const methods: string[] = [];
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin) return route.fallback();
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname === "/api/mcp", async route => {
        let rpc: { id?: string | number | null; method?: string };
        try { rpc = route.request().postDataJSON() as typeof rpc; }
        catch { await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        methods.push(method);
        const result = method === "ops.session" ? {
          actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" }, capabilities: ["platform.summary.read"],
        } : null;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });
      await page.goto(`${baseUrl}/${harnessName}.html?route=incidents&workbench=platform`, { waitUntil: "domcontentloaded" });
      await page.getByRole("main", { name: "总览" }).waitFor({ state: "visible" });
      expect(new URL(page.url()).pathname).toBe("/ops/overview");
      expect(await page.getByRole("heading", { name: "事故中心", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "事故中心", exact: true }).count()).toBe(0);
      expect(methods.some(method => method.startsWith("ops.incidents."))).toBe(false);
    } finally { await page.close(); }
  }, 60_000);
});

declare global {
  interface Window { __renderKnowledgeComponent?: boolean; __knowledgeLoadCount?: number; }
}
