import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("support queue filtered empty state", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-queue-empty-filter-"));
    const entryPath = "/__support-queue-empty-filter-entry.tsx";
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    vite = await createServer({
      configFile: false, root: appRoot, cacheDir: cacheDirectory, logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false }, plugins: [react(), {
        name: "support-queue-empty-filter-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { SupportQueueSection } from '/src/components/support/SupportQueueSection.tsx';
            const applied = [];
            window.__supportFilterResets = applied;
            const model = {
              workspaceId:'ws-test', tickets:[], filters:{query:'needle',customerId:'customer-4',status:'open',priority:'urgent',slaState:'at_risk',assigneeId:'operator-2'},
              loading:false,loadingMore:false,detailLoading:false,mutating:false,error:'',hasMore:false,
              setFilters:filters=>applied.push(filters),reload:async()=>{},loadMore:async()=>{},selectTicket:async()=>{},clearSelection:()=>{},
              create:async()=>{},assign:async()=>{},transition:async()=>{},comment:async()=>{},reportLoading:false,loadReport:async()=>{},
            };
            createRoot(document.getElementById('root')).render(React.createElement(App,null,React.createElement(SupportQueueSection,{model,canMutate:true})));
          `;
        },
        configureServer(server) { server.middlewares.use((req,res,next)=>{ if(!req.url?.startsWith("/__support-queue-empty-filter-test"))return next(); const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`; void server.transformIndexHtml(req.url,html).then(output=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(output)}).catch(next); }); },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support queue empty filter listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("explains that an empty list is caused by filters and clears every filter in one action", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${baseUrl}/__support-queue-empty-filter-test`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.getByText("没有符合当前筛选条件的工单", { exact: true }).waitFor();
      await page.getByRole("button", { name: "清除所有筛选条件" }).click();
      expect(await page.evaluate(() => window.__supportFilterResets)).toEqual([{ query: "" }]);
    } finally { await page.close(); }
  }, 60_000);
});

declare global { interface Window { __supportFilterResets: Array<{ query: string }> } }
