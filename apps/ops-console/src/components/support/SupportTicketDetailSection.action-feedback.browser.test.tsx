import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("support action dialog feedback", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-action-feedback-"));
    const entryPath = "/__support-action-feedback-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [react(), {
        name: "support-action-feedback-test",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App, ConfigProvider } from 'antd';
            import zhCN from 'antd/locale/zh_CN';
            import { SupportTicketDetailSection } from '/src/components/support/SupportTicketDetailSection.tsx';
            const ticket = { id:'ticket-1', workspaceId:'ws-1', ticketNumber:'SUP-101', subject:'订单状态异常', description:'工单测试描述', priority:'normal', customerId:'customer-1', customerName:'测试商家', tags:[], revision:1, createdBy:'operator-1', createdAt:'2026-10-01T00:00:00.000Z', updatedAt:'2026-10-01T00:00:00.000Z', status:'open', sla:{policy:{version:1,calendar:'business_weekday_utc',firstResponseMinutes:120,resolutionMinutes:480},firstResponseDueAt:'2026-10-01T02:00:00.000Z',resolutionDueAt:'2026-10-01T08:00:00.000Z',pausedMinutes:0,state:'on_track'} };
            const model = { workspaceId:'ws-1', tickets:[], selected:{ticket,events:[]}, filters:{query:''}, loading:false, loadingMore:false, detailLoading:false, mutating:false, hasMore:false, setFilters:()=>{}, reload:async()=>{}, loadMore:async()=>{}, selectTicket:async()=>{}, clearSelection:()=>{}, create:async()=>{}, assign:async()=>{ throw new Error('上次分配负责人失败'); }, transition:async()=>{}, comment:async()=>{}, reportLoading:false, loadReport:async()=>{} };
            createRoot(document.getElementById('root')).render(React.createElement(ConfigProvider,{locale:zhCN},React.createElement(App,null,React.createElement(SupportTicketDetailSection,{model,canMutate:true}))));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__support-action-feedback") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support action feedback listener did not bind");
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

  it("clears a failed assignment message when another action dialog opens", async () => {
    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const consoleErrors: string[] = [];
    page.on("requestfailed", request => failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? "unknown"}`));
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.setDefaultTimeout(10_000);
    try {
      // Wait for the HTML response, then use the actionable control as the
      // readiness signal. Vite can still be compiling the module graph after
      // document commit on a cold or busy runner.
      await page.goto(`${baseUrl}/__support-action-feedback`, { waitUntil: "commit", timeout: 60_000 });
      const assignButton = page.getByRole("button", { name: "分配负责人", exact: true });
      try {
        await assignButton.waitFor({ state: "visible", timeout: 60_000 });
      } catch (cause) {
        const runtime = await page.evaluate(() => ({ readyState: document.readyState, root: document.querySelector("#root")?.innerHTML ?? "", resources: performance.getEntriesByType("resource").map(entry => entry.name) }))
          .catch(() => ({ readyState: "unavailable", root: "<root unavailable>", resources: [] as string[] }));
        throw new Error(`Support action fixture did not become interactive. ${JSON.stringify({ pageErrors, failedRequests, consoleErrors, runtime })}`, { cause });
      }
      await assignButton.click();
      const assignDialog = page.getByRole("dialog", { name: "分配工单" });
      await assignDialog.waitFor();
      await assignDialog.getByLabel("负责人 ID", { exact: true }).fill("operator-2");
      await assignDialog.getByRole("button", { name: "确认分配", exact: true }).click();
      await assignDialog.getByRole("alert").getByText("上次分配负责人失败", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await assignDialog.waitFor({ state: "hidden" });

      await page.getByRole("button", { name: "添加备注", exact: true }).click();
      const commentDialog = page.getByRole("dialog").filter({ hasText: "添加工单备注" });
      try {
        await commentDialog.waitFor({ timeout: 20_000 });
      } catch (cause) {
        const dialogs = await page.getByRole("dialog").allTextContents().catch(() => []);
        const buttons = await page.getByRole("button").allTextContents().catch(() => []);
        throw new Error(`Support comment dialog did not open. pageErrors=${JSON.stringify(pageErrors)} dialogs=${JSON.stringify(dialogs)} buttons=${JSON.stringify(buttons)}`, { cause });
      }
      expect(await commentDialog.getByRole("alert").count()).toBe(0);
      expect(await commentDialog.getByText("上次分配负责人失败", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  }, 120_000);
});
