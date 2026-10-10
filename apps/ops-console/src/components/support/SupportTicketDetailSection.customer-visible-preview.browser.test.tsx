import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("support customer-visible reply confirmation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-customer-preview-"));
    const entryPath = "/__support-customer-preview-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [react(), {
        name: "support-customer-visible-preview-test",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App, ConfigProvider } from 'antd';
            import zhCN from 'antd/locale/zh_CN';
            import { SupportTicketDetailSection } from '/src/components/support/SupportTicketDetailSection.tsx';
            const ticket = { id:'ticket-1', workspaceId:'ws-1', ticketNumber:'SUP-101', subject:'订单状态异常', description:'工单测试描述', priority:'normal', customerId:'customer-1', customerName:'测试商家', tags:[], revision:1, createdBy:'operator-1', createdAt:'2026-10-01T00:00:00.000Z', updatedAt:'2026-10-01T00:00:00.000Z', status:'open' };
            window.__supportCommentCalls = [];
            const model = { workspaceId:'ws-1', tickets:[], selected:{ticket,events:[]}, filters:{query:''}, loading:false, loadingMore:false, detailLoading:false, mutating:false, hasMore:false, setFilters:()=>{}, reload:async()=>{}, loadMore:async()=>{}, selectTicket:async()=>{}, clearSelection:()=>{}, create:async()=>{}, assign:async()=>{}, transition:async()=>{}, comment:async(body,visibility)=>{ window.__supportCommentCalls.push({body,visibility}); }, reportLoading:false, loadReport:async()=>{} };
            createRoot(document.getElementById('root')).render(React.createElement(ConfigProvider,{locale:zhCN},React.createElement(App,null,React.createElement(SupportTicketDetailSection,{model,canMutate:true}))));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__support-customer-preview") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support customer preview listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("previews customer-visible text and requires explicit confirmation before recording it", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    try {
      await page.goto(`${baseUrl}/__support-customer-preview`, { waitUntil: "commit", timeout: 60_000 });
      await page.getByRole("button", { name: "添加备注", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
      await page.getByRole("button", { name: "添加备注", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "添加工单备注" });
      await dialog.getByLabel("可见范围").click();
      await page.getByText("客户可见回复", { exact: true }).last().click();
      const reply = dialog.getByLabel("客户可见回复正文");
      await reply.fill("  支付状态已核实，请重新打开订单页面查看。  ");
      await dialog.getByRole("button", { name: "预览客户可见回复" }).click();

      const preview = page.getByRole("dialog", { name: "核对客户可见回复" });
      await preview.getByText("客户：测试商家（customer-1）", { exact: true }).waitFor();
      await preview.getByText("支付状态已核实，请重新打开订单页面查看。", { exact: true }).waitFor();
      expect(await page.evaluate(() => window.__supportCommentCalls)).toEqual([]);

      await preview.getByRole("button", { name: "取消回复并丢弃" }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await page.evaluate(() => window.__supportCommentCalls)).toEqual([]);

      await page.getByRole("button", { name: "添加备注", exact: true }).click();
      const secondDialog = page.getByRole("dialog", { name: "添加工单备注" });
      await secondDialog.getByLabel("可见范围").click();
      await page.getByText("客户可见回复", { exact: true }).last().click();
      await secondDialog.getByLabel("客户可见回复正文").fill("  支付状态已核实，请重新打开订单页面查看。  ");
      await secondDialog.getByRole("button", { name: "预览客户可见回复" }).click();
      const confirmedPreview = page.getByRole("dialog", { name: "核对客户可见回复" });
      await confirmedPreview.getByText("客户：测试商家（customer-1）", { exact: true }).waitFor();
      await confirmedPreview.getByText("支付状态已核实，请重新打开订单页面查看。", { exact: true }).waitFor();
      expect(await page.evaluate(() => window.__supportCommentCalls)).toEqual([]);
      await confirmedPreview.getByRole("button", { name: "返回修改" }).click();
      expect(await secondDialog.getByLabel("客户可见回复正文").inputValue()).toBe("支付状态已核实，请重新打开订单页面查看。");
      expect(await page.evaluate(() => window.__supportCommentCalls)).toEqual([]);

      await secondDialog.getByRole("button", { name: "预览客户可见回复" }).click();
      await page.getByRole("dialog", { name: "核对客户可见回复" }).getByRole("button", { name: "确认添加客户可见回复" }).click();
      await page.waitForFunction(() => window.__supportCommentCalls?.length === 1);
      expect(await page.evaluate(() => window.__supportCommentCalls)).toEqual([{ body: "支付状态已核实，请重新打开订单页面查看。", visibility: "customer" }]);

      await page.getByRole("button", { name: "添加备注", exact: true }).click();
      const internalDialog = page.getByRole("dialog", { name: "添加工单备注" });
      await internalDialog.getByLabel("可见范围").click();
      await page.getByText("仅内部", { exact: true }).last().click();
      await internalDialog.getByLabel("内部备注内容").fill("  已在后台确认付款流水。  ");
      await internalDialog.getByRole("button", { name: "添加备注", exact: true }).click();
      await page.waitForFunction(() => window.__supportCommentCalls?.length === 2);
      expect(await page.evaluate(() => window.__supportCommentCalls)).toEqual([
        { body: "支付状态已核实，请重新打开订单页面查看。", visibility: "customer" },
        { body: "已在后台确认付款流水。", visibility: "internal" },
      ]);
    } finally { await page.close(); }
  }, 120_000);
});

declare global {
  interface Window { __supportCommentCalls?: Array<{ body: string; visibility: string }> }
}
