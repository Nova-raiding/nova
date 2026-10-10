import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("support mutation uncertain result idempotency", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-uncertain-mutation-"));
    const entryPath = "/__support-uncertain-mutation-entry.tsx";
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    vite = await createServer({
      configFile: false, root: appRoot, cacheDir: cacheDirectory, logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false }, plugins: [react(), {
        name: "support-uncertain-mutation-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { useSupportDomain } from '/src/hooks/useSupportDomain.ts';
            let ticket = { id:'ticket-1', workspaceId:'ws-1', ticketNumber:'SUP-1', subject:'测试工单', description:'问题描述', status:'open', priority:'normal', customerId:'customer-1', customerName:'客户', tags:[], revision:1, createdBy:'ops-1', createdAt:'2026-10-01T00:00:00.000Z', updatedAt:'2026-10-01T00:00:00.000Z' };
            let events = [];
            const commands = { assign:[], transition:[], comment:[] };
            const sideEffects = { assign:0, transition:0, comment:0 };
            const failFirst = { assign:true, transition:true, comment:true };
            window.__commands = commands;
            window.__sideEffects = sideEffects;
            const client = {
              async list(){ return {items:[ticket]}; },
              async get(){ return {ticket,events}; },
              async create(){ throw new Error('not used'); },
              async assign(command){ return mutate('assign',command,()=>{ticket={...ticket,assignedTo:command.assigneeId};}); },
              async transition(command){ return mutate('transition',command,()=>{ticket={...ticket,status:command.status};}); },
              async comment(command){ return mutate('comment',command,()=>{}); },
              async report(){ throw new Error('not used'); }, async createCorrection(){ throw new Error('not used'); }, async decideCorrection(){ throw new Error('not used'); },
            };
            function mutate(kind, command, change){
              commands[kind].push({...command});
              const existing=events.find(event=>event.idempotencyKey===command.idempotencyKey);
              if(existing)return Promise.resolve({ticket,event:existing,replayed:true});
              change(); ticket={...ticket,revision:ticket.revision+1,updatedAt:new Date().toISOString()};
              const event={id:kind+'-'+ticket.revision,workspaceId:command.workspaceId,ticketId:command.ticketId,sequence:ticket.revision,eventType:kind==='assign'?'assigned':kind==='transition'?'status_changed':'commented',actorId:'ops-1',idempotencyKey:command.idempotencyKey,payload:kind==='assign'?{to:command.assigneeId}:kind==='transition'?{to:command.status,reason:command.reason}:{body:command.body,visibility:command.visibility},createdAt:new Date().toISOString()};
              events=[...events,event]; sideEffects[kind]++;
              if(failFirst[kind]){failFirst[kind]=false;return Promise.reject(Object.assign(new Error(kind+' response lost after commit'),{httpStatus:504}));}
              return Promise.resolve({ticket,event,replayed:false});
            }
            function Harness(){
              const model=useSupportDomain(client,'ws-1');
              return React.createElement('main',null,
                React.createElement('button',{onClick:()=>void model.selectTicket('ticket-1')},'select'),
                React.createElement('button',{onClick:()=>void model.assign('support-owner').catch(()=>{})},'assign'),
                React.createElement('button',{onClick:()=>void model.transition('in_progress','开始处理').catch(()=>{})},'transition'),
                React.createElement('button',{onClick:()=>void model.comment('核对后的回复','customer').catch(()=>{})},'comment'),
                React.createElement('output',{'data-testid':'state'},JSON.stringify({revision:model.selected?.ticket.revision,error:model.error})),
                React.createElement('output',{'data-testid':'commands'},JSON.stringify(commands)),
                React.createElement('output',{'data-testid':'effects'},JSON.stringify(sideEffects)));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) { server.middlewares.use((req,res,next)=>{ if(!req.url?.startsWith("/__support-uncertain-mutation-test"))return next(); const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`; void server.transformIndexHtml(req.url,html).then(output=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(output)}).catch(next); }); },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support uncertain mutation listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("reuses each unresolved assign, transition, and comment intent after commit-before-timeout", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(8_000);
    try {
      await page.goto(`${baseUrl}/__support-uncertain-mutation-test`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.getByRole("button", { name: "select" }).click();
      await expect.poll(() => page.getByTestId("state").textContent()).toContain('"revision":1');
      for (const name of ["assign", "transition", "comment"]) {
        await page.getByRole("button", { name }).click();
        await expect.poll(async () => page.evaluate(() => JSON.stringify({
          state: document.querySelector('[data-testid="state"]')?.textContent,
          commands: window.__commands,
          effects: window.__sideEffects,
        })), { timeout: 12_000 }).toContain(name + " response lost after commit");
        await page.getByRole("button", { name }).click();
        await expect.poll(() => page.getByTestId("state").textContent(), { timeout: 12_000 }).not.toContain(name + " response lost after commit");
      }
      const commands = JSON.parse((await page.getByTestId("commands").textContent()) || "{}");
      const effects = JSON.parse((await page.getByTestId("effects").textContent()) || "{}");
      for (const name of ["assign", "transition", "comment"]) {
        expect(commands[name]).toHaveLength(2);
        expect(commands[name][0]).toEqual(commands[name][1]);
        expect(commands[name][0]).toMatchObject({ workspaceId: "ws-1", ticketId: "ticket-1", expectedRevision: name === "assign" ? 1 : name === "transition" ? 2 : 3 });
        expect(commands[name][0].idempotencyKey).toBeTruthy();
        expect(effects[name]).toBe(1);
      }
      expect(commands.comment[0]).toMatchObject({ body: "核对后的回复", visibility: "customer" });
      expect(commands.transition[0]).toMatchObject({ status: "in_progress", reason: "开始处理" });
      expect(commands.assign[0]).toMatchObject({ assigneeId: "support-owner" });
    } finally { await page.close(); }
  }, 60_000);
});

declare global { interface Window { __commands: Record<string, Array<Record<string, unknown>>>; __sideEffects: Record<string, number> } }
