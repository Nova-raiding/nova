import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("platform support cursor paging browser regression", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "platform-support-paging-"));
    const entryPath = "/__platform-support-paging-entry.tsx";
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    vite = await createServer({
      configFile: false, root: appRoot, cacheDir: cacheDirectory, logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false }, plugins: [react(), {
        name: "platform-support-paging-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { PlatformSupportWorkspace } from '/src/components/support/PlatformSupportWorkspace.tsx';
            const ticket = (id, ticketNumber, status) => ({ id, workspaceId:'ws-real', ticketNumber, subject:'关于 '+ticketNumber, customerName:'真实客户', customerId:'customer-1', status, revision:1, relatedOrderId:null, relatedTaskId:null, description:'真实工单', aggregate:false });
            window.__supportCalls = [];
            const model = { authorization:{can:cap=>cap==='support.ticket.read'||cap==='workspace.directory.read'}, opsSession:{actor_id:'operator-1'}, workspaceDirectory:{items:[{workspaceId:'ws-real',enterpriseName:'真实企业',status:'active'}],offset:0,limit:20,hasMore:false}, workspaceDirectoryLoading:false, workspaceDirectoryError:'', loadWorkspaceDirectory:async()=>true };
            const firstTicket=ticket('t1','SUP-1','in_progress');
            const client = { list:async(_workspace,cursor)=>{ window.__supportCalls.push(cursor?.id||'first'); if(!cursor)return {items:[firstTicket],nextCursor:{id:'p2',createdAt:'2026-10-01T00:00:00.000Z'}}; if(cursor.id==='p2')return {items:[ticket('t2','SUP-2','open')],nextCursor:{id:'p3',createdAt:'2026-09-30T00:00:00.000Z'}}; throw new Error('page three failed'); }, get:async()=>({ticket:firstTicket,events:[]}), comment:async()=>{throw new Error('not used')} };
            createRoot(document.getElementById('root')).render(React.createElement(App,null,React.createElement(PlatformSupportWorkspace,{model,client})));
          `;
        },
        configureServer(server) { server.middlewares.use((req,res,next)=>{ if(!req.url?.startsWith('/__platform-support-paging-test'))return next(); const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`; void server.transformIndexHtml(req.url,html).then(output=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(output)}).catch(next); }); },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Platform support paging listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("keeps successful pages for back navigation and leaves the current page on a failed next request", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => console.error("platform-support-paging-pageerror", error));
    try {
      await page.goto(`${baseUrl}/__platform-support-paging-test`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("button", { name: "读取授权企业目录" }).click();
      await page.getByLabel("选择支持目标企业").click();
      await page.getByText(/真实企业 · ws-real/).click();
      await page.getByRole("button", { name: "读取企业工单" }).click();
      await page.getByText("SUP-1", { exact: true }).waitFor();
      await expectText(page, "处理中");

      await page.getByRole("button", { name: "下一页工单" }).click();
      await page.getByText("SUP-2", { exact: true }).waitFor();
      await expectText(page, "待处理");

      await page.getByRole("button", { name: "下一页工单" }).click();
      await page.getByRole("alert").getByText("page three failed").waitFor();
      await page.getByText("SUP-2", { exact: true }).waitFor();
      await expectText(page, "待处理");

      await page.getByRole("button", { name: "上一页工单" }).click();
      await page.getByText("SUP-1", { exact: true }).waitFor();
      await expectText(page, "处理中");
      await page.getByRole("button", { name: "下一页工单" }).click();
      await page.getByText("SUP-2", { exact: true }).waitFor();
      await expectText(page, "待处理");
      await page.getByRole("button", { name: "上一页工单" }).click();
      await page.getByText("SUP-1", { exact: true }).waitFor();
      await page.getByRole("button", { name: "查看 SUP-1" }).click();
      await page.getByText("处理中 / 1", { exact: true }).waitFor();
      expect(await page.evaluate(() => window.__supportCalls)).toEqual(["first", "p2", "p3"]);
    } finally { await page.close(); }
  }, 60_000);
});

async function expectText(page: import("playwright").Page, value: string) {
  await page.getByText(value, { exact: true }).first().waitFor();
}

declare global { interface Window { __supportCalls: string[] } }
