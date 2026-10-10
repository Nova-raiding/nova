import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("support queue row interactions", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-row-interaction-"));
    const entryPath = "/__support-row-interaction-entry.tsx";
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    vite = await createServer({
      configFile: false,
      root: appRoot,
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [react(), {
        name: "support-row-interaction-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { SupportQueueSection } from '/src/components/support/SupportQueueSection.tsx';
            const ticket = {
              id: 'ticket-1', ticketNumber: 'SUP-001', subject: '支付未到账', customerId: 'customer-1', customerName: '示例客户',
              priority: 'normal', status: 'open', assignedTo: undefined, createdBy: 'agent-1',
              createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
              relatedTaskId: 'task-1', relatedOrderId: undefined,
            };
            function Harness() {
              const model = {
                workspaceId: 'ws_test', tickets: [ticket], filters: { query: '' }, loading: false, loadingMore: false,
                detailLoading: false, mutating: false, error: '', hasMore: false, setFilters: () => {}, reload: async () => {},
                loadMore: async () => {}, selectTicket: async id => { window.__supportSelected.push(id); }, clearSelection: () => {},
                create: async () => {}, assign: async () => {}, transition: async () => {}, comment: async () => {},
                reportLoading: false, loadReport: async () => {},
              };
              return React.createElement(App, null, React.createElement(SupportQueueSection, { model }));
            }
            window.__supportSelected = [];
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__support-row-interaction-test")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support row regression listener did not bind");
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

  it("keeps copy controls independent from opening the ticket row", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    const diagnostics: { failed: string[]; responses: string[]; errors: string[]; console: string[] } = { failed: [], responses: [], errors: [], console: [] };
    page.on("requestfailed", request => diagnostics.failed.push(`${request.url()} ${request.failure()?.errorText ?? "unknown"}`));
    page.on("response", response => { if (response.url().startsWith(baseUrl)) diagnostics.responses.push(`${response.status()} ${response.url()}`); });
    page.on("pageerror", error => diagnostics.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") diagnostics.console.push(message.text()); });
    try {
      await page.goto(`${baseUrl}/__support-row-interaction-test`, { waitUntil: "commit" });
      try { await page.getByText("SUP-001", { exact: true }).waitFor({ timeout: 60_000 }); }
      catch {
        const runtime = await page.evaluate(() => ({ readyState: document.readyState, root: document.querySelector("#root")?.innerHTML ?? "", resources: performance.getEntriesByType("resource").map(entry => entry.name), selected: window.__supportSelected }));
        throw new Error(`Support row fixture failed before render: ${JSON.stringify({ runtime, diagnostics })}`);
      }
      const row = page.locator('.ant-table-row[data-row-key="ticket-1"]');
      const openButton = row.getByRole("button", { name: "打开工单 SUP-001 支付未到账" });
      expect(await row.getAttribute("role")).not.toBe("button");
      await row.locator(".ant-typography-copy").click();
      expect(await page.evaluate(() => window.__supportSelected)).toEqual([]);
      await openButton.focus();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.__supportSelected)).toEqual(["ticket-1"]);
      await page.evaluate(() => { window.__supportSelected = []; });
      await row.getByText("示例客户", { exact: true }).click();
      expect(await page.evaluate(() => window.__supportSelected)).toEqual(["ticket-1"]);
    } finally { await page.close(); }
  }, 90_000);
});

declare global {
  interface Window { __supportSelected: string[] }
}
