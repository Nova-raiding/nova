import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("support ticket detail read recovery", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-detail-recovery-"));
    const entryPath = "/__support-detail-recovery-entry.tsx";
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    vite = await createServer({
      configFile: false, root: appRoot, cacheDir: cacheDirectory, logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false }, plugins: [react(), {
        name: "support-detail-read-recovery",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { SupportQueueSection } from '/src/components/support/SupportQueueSection.tsx';
            import { SupportTicketDetailSection } from '/src/components/support/SupportTicketDetailSection.tsx';
            import { useSupportDomain } from '/src/hooks/useSupportDomain.ts';
            const ticket = { id:'ticket-1', workspaceId:'ws-1', ticketNumber:'SUP-001', subject:'支付异常', description:'客户付款未到账', status:'open', priority:'normal', customerId:'customer-1', customerName:'云朵商家', tags:[], revision:1, createdBy:'operator-1', createdAt:'2026-10-01T00:00:00.000Z', updatedAt:'2026-10-01T00:00:00.000Z' };
            const calls = { list:0, get:0 };
            window.__supportReadCalls = calls;
            const client = {
              async list(){ calls.list++; return { items:[ticket] }; },
              async get(){ calls.get++; if(calls.get===1) throw new Error('详情接口暂时不可用'); return { ticket, events:[] }; },
              async create(){ throw new Error('not used'); }, async assign(){ throw new Error('not used'); },
              async transition(){ throw new Error('not used'); }, async comment(){ throw new Error('not used'); },
              async report(){ throw new Error('not used'); }, async createCorrection(){ throw new Error('not used'); }, async decideCorrection(){ throw new Error('not used'); },
            };
            function Harness(){
              const model=useSupportDomain(client,'ws-1');
              return React.createElement(App,null,React.createElement(React.Fragment,null,
                React.createElement(SupportQueueSection,{model,canMutate:true}),
                React.createElement(SupportTicketDetailSection,{model,canMutate:true})));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) { server.middlewares.use((req,res,next)=>{ if(!req.url?.startsWith("/__support-detail-recovery-test"))return next(); const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`; void server.transformIndexHtml(req.url,html).then(output=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(output)}).catch(next); }); },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support detail recovery listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("shows a detail-specific retry and retries the selected detail instead of refreshing the queue", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(10_000);
    const diagnostics: { failed: string[]; responses: string[]; errors: string[]; console: string[] } = { failed: [], responses: [], errors: [], console: [] };
    page.on("requestfailed", request => diagnostics.failed.push(`${request.url()} ${request.failure()?.errorText ?? "unknown"}`));
    page.on("response", response => { if (response.url().startsWith(baseUrl)) diagnostics.responses.push(`${response.status()} ${response.url()}`); });
    page.on("pageerror", error => diagnostics.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") diagnostics.console.push(message.text()); });
    try {
      // The first Vite transform of Ant Design can take longer on a cold cache
      // while other repo-wide test workers are compiling. Wait for the fixture
      // UI after the document commit instead of treating a cold module graph as
      // a detail-read regression.
      await page.goto(`${baseUrl}/__support-detail-recovery-test`, { waitUntil: "commit", timeout: 60_000 });
      try { await page.getByRole("button", { name: "打开工单 SUP-001 支付异常" }).waitFor({ state: "visible", timeout: 60_000 }); }
      catch {
        const runtime = await page.evaluate(() => ({ readyState: document.readyState, root: document.querySelector("#root")?.innerHTML ?? "", resources: performance.getEntriesByType("resource").map(entry => entry.name), calls: window.__supportReadCalls }));
        throw new Error(`Support detail fixture failed before render: ${JSON.stringify({ runtime, diagnostics })}`);
      }
      await page.getByRole("button", { name: "打开工单 SUP-001 支付异常" }).click();
      await page.getByRole("alert").filter({ hasText: "工单详情读取失败" }).waitFor();
      expect(await page.getByText("工单队列读取失败").count()).toBe(0);
      await page.getByRole("button", { name: "重新加载工单详情" }).click();
      await page.getByText("SUP-001 · 支付异常").waitFor();
      expect(await page.getByText("工单队列读取失败").count()).toBe(0);
      expect(await page.evaluate(() => window.__supportReadCalls)).toEqual({ list: 1, get: 2 });
    } finally { await page.close(); }
  }, 90_000);
});

declare global { interface Window { __supportReadCalls: { list: number; get: number } } }
