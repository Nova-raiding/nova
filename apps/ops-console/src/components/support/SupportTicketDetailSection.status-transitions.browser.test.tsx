import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("support ticket detail status controls", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-detail-status-"));
    const entryPath = "/__support-detail-status-entry.tsx";
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    vite = await createServer({
      configFile: false, root: appRoot, cacheDir: cacheDirectory, logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false }, plugins: [react(), {
        name: "support-detail-status-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { SupportTicketDetailSection } from '/src/components/support/SupportTicketDetailSection.tsx';
            const statuses = ['open','in_progress','waiting_customer','resolved','closed'];
            const labels = {open:'待处理',in_progress:'处理中',waiting_customer:'等待客户',resolved:'已解决',closed:'已关闭'};
            const baseTicket = { id:'ticket-1', workspaceId:'ws-1', ticketNumber:'SUP-001', subject:'支付异常', description:'客户付款未到账', priority:'normal', customerId:'customer-1', customerName:'云朵商家', tags:[], revision:1, createdBy:'operator-1', createdAt:'2026-10-01T00:00:00.000Z', updatedAt:'2026-10-01T00:00:00.000Z', sla:{policy:{version:1,calendar:'business_weekday_utc',firstResponseMinutes:120,resolutionMinutes:480},firstResponseDueAt:'2026-10-01T02:00:00.000Z',resolutionDueAt:'2026-10-01T08:00:00.000Z',pausedMinutes:0,state:'on_track'} };
            function Harness() {
              const [status,setStatus] = useState('open');
              const [ticketId,setTicketId] = useState('ticket-1');
              const [error,setError] = useState('');
              window.__setSupportStatus = setStatus;
              window.__setSupportTicket = (id, nextStatus) => { setTicketId(id); setStatus(nextStatus); };
              window.__setSupportError = setError;
              const model = { workspaceId:'ws-1', tickets:[], selected:{ticket:{...baseTicket,id:ticketId,status},events:[]}, filters:{query:''}, loading:false, loadingMore:false, detailLoading:false, mutating:false, error, hasMore:false, setFilters:()=>{}, reload:async()=>{}, loadMore:async()=>{}, selectTicket:async()=>{}, clearSelection:()=>{}, create:async()=>{}, assign:async()=>{}, transition:async()=>{}, comment:async()=>{}, reportLoading:false, loadReport:async()=>{} };
              return React.createElement(App,null,React.createElement(SupportTicketDetailSection,{model,canMutate:true}));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) { server.middlewares.use((req,res,next)=>{ if(!req.url?.startsWith('/__support-detail-status-test'))return next(); const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`; void server.transformIndexHtml(req.url,html).then(output=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(output)}).catch(next); }); },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support detail status listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("shows localized status and offers only service-approved transitions for every current status", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${baseUrl}/__support-detail-status-test`, { waitUntil: "commit" });
      await page.getByRole("button", { name: "变更状态" }).waitFor({ state: "visible" });
      const matrix: Record<string, { label: string; allowed: string[] }> = {
        open: { label: "待处理", allowed: ["in_progress", "closed"] },
        in_progress: { label: "处理中", allowed: ["open", "waiting_customer", "resolved"] },
        waiting_customer: { label: "等待客户", allowed: ["in_progress", "resolved"] },
        resolved: { label: "已解决", allowed: ["in_progress", "closed"] },
        closed: { label: "已关闭", allowed: ["in_progress"] },
      };
      const labelsByStatus: Record<string, string> = {
        open: "待处理",
        in_progress: "处理中",
        waiting_customer: "等待客户",
        resolved: "已解决",
        closed: "已关闭",
      };
      for (const [status, expected] of Object.entries(matrix)) {
        await page.evaluate(statusValue => window.__setSupportStatus(statusValue), status);
        await page.getByText(expected.label, { exact: true }).first().waitFor();
        const openButton = page.getByRole("button", { name: "变更状态" });
        await openButton.waitFor({ state: "visible" });
        await openButton.click();
        const dialog = page.getByRole("dialog");
        await dialog.locator(".ant-select").click();
        const selectedLabel = await page.locator(".ant-select-item-option-selected .ant-select-item-option-content").textContent();
        expect(selectedLabel?.trim()).toBe(labelsByStatus[expected.allowed[0]]);
        const options = await page.locator(".ant-select-item-option-content").allTextContents();
        expect(options.map(value => value.trim())).toEqual(expected.allowed.map(value => labelsByStatus[value]));
        await page.locator(".ant-modal-footer button").first().click();
        await dialog.waitFor({ state: "hidden" });
      }

      await page.evaluate(() => window.__setSupportStatus("in_progress"));
      await page.getByRole("button", { name: "变更状态" }).click();
      let dialog = page.getByRole("dialog");
      await dialog.locator(".ant-select").click();
      await page.locator(".ant-select-item-option-content").getByText("已解决", { exact: true }).click();
      await dialog.locator("textarea").fill("问题已定位并修复");
      await page.locator(".ant-modal-footer button").first().click();
      await dialog.waitFor({ state: "hidden" });

      await page.getByRole("button", { name: "变更状态" }).click();
      dialog = page.getByRole("dialog");
      await dialog.locator(".ant-select").click();
      const resetTarget = await page.locator(".ant-select-item-option-selected .ant-select-item-option-content").textContent();
      expect(resetTarget?.trim()).toBe(labelsByStatus.open);
      expect(await dialog.locator("textarea").inputValue()).toBe("");
      expect(await page.locator(".ant-modal-footer button").last().isDisabled()).toBe(true);
      await dialog.locator("textarea").fill("旧工单的未提交原因");
      await page.evaluate(() => window.__setSupportTicket("ticket-2", "waiting_customer"));
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "变更状态" }).click();
      dialog = page.getByRole("dialog");
      await dialog.locator(".ant-select").click();
      const nextTicketDefault = await page.locator(".ant-select-item-option-selected .ant-select-item-option-content").textContent();
      expect(nextTicketDefault?.trim()).toBe(labelsByStatus.in_progress);
      expect(await dialog.locator("textarea").inputValue()).toBe("");
      await page.locator(".ant-modal-footer button").first().click();
      await dialog.waitFor({ state: "hidden" });

      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.evaluate(() => window.__setSupportError("权限已失效，请刷新权限后重试。"));
      const operationError = page.locator('[aria-labelledby="support-detail-error-title"]');
      await operationError.waitFor();
      await operationError.getByRole("button", { name: "关闭提示" }).click();
      await operationError.waitFor({ state: "detached" });
      await page.evaluate(() => window.__setSupportError("工单状态已更新，请刷新后重试。"));
      await page.getByRole("alert").filter({ hasText: "工单状态已更新" }).waitFor();
    } finally { await page.close(); }
  }, 60_000);
});

declare global {
  interface Window {
    __setSupportStatus: (status: string) => void;
    __setSupportTicket: (id: string, status: string) => void;
    __setSupportError: (error: string) => void;
  }
}
