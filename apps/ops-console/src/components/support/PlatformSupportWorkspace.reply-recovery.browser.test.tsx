import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("platform support reply recovery after reload", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "platform-support-reply-recovery-"));
    const entryPath = "/__platform-support-recovery-entry.tsx";
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    vite = await createServer({
      configFile: false, root: appRoot, cacheDir: cacheDirectory, logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false }, plugins: [react(), {
        name: "platform-support-reply-recovery-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { PlatformSupportWorkspace } from '/src/components/support/PlatformSupportWorkspace.tsx';
            const ticket={id:'ticket-1',workspaceId:'ws-1',ticketNumber:'SUP-1',subject:'测试工单',description:'客户问题',status:'open',priority:'normal',customerId:'customer-1',customerName:'测试客户',tags:[],revision:1,createdBy:'ops-1',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'};
            const calls=[]; const events=[]; let effects=0;
            window.__replyCalls=calls; window.__replyEffects=()=>effects;
            const model={authorization:{can:cap=>cap==='support.ticket.read'||cap==='support.ticket.update'||cap==='workspace.directory.read'},opsSession:{actor_id:'operator-1'},workspaceDirectory:{items:[],offset:0,limit:20,hasMore:false},workspaceDirectoryLoading:false,workspaceDirectoryError:'',loadWorkspaceDirectory:async()=>true};
            const client={
              async list(){return {items:[ticket]};},
              async get(){return {ticket,events};},
              async comment(command){
                calls.push({...command});
                const existing=events.find(event=>event.idempotencyKey===command.idempotencyKey);
                if(existing)return {ticket:{...ticket,revision:2},event:existing,replayed:true};
                effects++;
                const event={id:'event-reply',workspaceId:'ws-1',ticketId:'ticket-1',sequence:2,eventType:'commented',actorId:'operator-1',idempotencyKey:command.idempotencyKey,payload:{body:command.body,visibility:command.visibility,expectedRevision:command.expectedRevision},createdAt:new Date().toISOString()};
                events.push(event);
                throw Object.assign(new Error('gateway timeout after commit'),{httpStatus:504});
              }
            };
            createRoot(document.getElementById('root')).render(React.createElement(App,null,React.createElement(PlatformSupportWorkspace,{model,client})));
          `;
        },
        configureServer(server) { server.middlewares.use((req,res,next)=>{ if(!req.url?.startsWith("/__platform-support-recovery-test"))return next(); const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`; void server.transformIndexHtml(req.url,html).then(output=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(output)}).catch(next); }); },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Platform support reply recovery listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("restores metadata only, verifies re-entered body, and retries the same key without a duplicate event", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(10_000);
    const body = "已核对同意退款流程";
    const intent = { workspaceId: "ws-1", ticketId: "ticket-1", actorId: "operator-1", idempotencyKey: "support_reply_original_001", visibility: "customer", expectedRevision: 1, bodyHash: createHash("sha256").update(body).digest("hex") };
    try {
      await page.addInitScript(({ intent: saved }) => {
        sessionStorage.setItem("platform-support-reply:ws-1", JSON.stringify(saved));
        sessionStorage.setItem("platform-support-active-reply", JSON.stringify({ workspaceId: saved.workspaceId, actorId: saved.actorId }));
      }, { intent });
      await page.goto(`${baseUrl}/__platform-support-recovery-test`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.getByRole("button", { name: "查询并核实原回复" }).waitFor();
      await page.getByText("目标企业：ws-1", { exact: true }).waitFor();
      await page.getByText(/原企业 ws-1；原工单 ticket-1/u).waitFor();
      expect(await page.getByLabel("选择支持目标企业").getAttribute("disabled")).not.toBeNull();
      await page.getByRole("button", { name: "查询并核实原回复" }).click();
      const input = page.getByLabel("平台支持回复正文");
      await input.fill(body);
      await page.getByRole("button", { name: "校验正文并恢复原回复" }).click();
      await page.getByRole("button", { name: "按原键重试同一回复" }).click();
      await page.getByRole("button", { name: "按原键重试同一回复" }).waitFor();
      await page.getByRole("button", { name: "按原键重试同一回复" }).click();
      await page.getByRole("status").getByText(/真实工单回复已记录/).waitFor();
      const calls = await page.evaluate(() => window.__replyCalls);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ workspaceId: "ws-1", ticketId: "ticket-1", body, visibility: "customer", expectedRevision: 1, idempotencyKey: intent.idempotencyKey });
      expect(calls[1]).toEqual(calls[0]);
      expect(await page.evaluate(() => window.__replyEffects())).toBe(1);
      expect(await page.evaluate(() => sessionStorage.getItem("platform-support-reply:ws-1"))).toBeNull();
      expect(await page.evaluate(() => sessionStorage.getItem("platform-support-active-reply"))).toBeNull();
    } finally { await page.close(); }
  }, 60_000);
});

declare global { interface Window { __replyCalls: Array<Record<string, unknown>>; __replyEffects: () => number } }
