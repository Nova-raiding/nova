import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("support ticket required fields trim validation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-whitespace-validation-"));
    const entryPath = "/__support-whitespace-entry.tsx";
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    vite = await createServer({
      configFile: false,
      root: appRoot,
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [react(), {
        name: "support-whitespace-validation",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { SupportQueueSection } from '/src/components/support/SupportQueueSection.tsx';
            function Harness() {
              const model = {
                workspaceId: 'ws_test', tickets: [], filters: { query: '' }, loading: false, loadingMore: false,
                detailLoading: false, mutating: false, error: '', hasMore: false, setFilters: () => {}, reload: async () => {},
                loadMore: async () => {}, selectTicket: async () => {}, clearSelection: () => {},
                create: async payload => { window.__supportCreatePayloads = [...(window.__supportCreatePayloads || []), payload]; },
                assign: async () => {}, transition: async () => {}, comment: async () => {}, reportLoading: false, loadReport: async () => {},
              };
              return React.createElement(App, null, React.createElement(SupportQueueSection, { model, canMutate: true }));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__support-whitespace-test")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support whitespace regression listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("blocks whitespace-only values and submits trimmed values", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    const fixtureModuleResponses: Array<{ url: string; status: number }> = [];
    page.on("requestfailed", request => console.error("support-whitespace-requestfailed", request.url(), request.failure()?.errorText));
    page.on("response", response => {
      if (response.url().includes("/src/components/support/SupportQueueSection.tsx")) {
        fixtureModuleResponses.push({ url: response.url(), status: response.status() });
      }
    });
    page.on("pageerror", error => console.error("support-whitespace-pageerror", error));
    page.on("console", message => { if (message.type() === "error") console.error("support-whitespace-console", message.text()); });
    await page.addInitScript(() => window.addEventListener("error", event => console.error("support-whitespace-window-error", event.filename, event.lineno, event.colno, event.message)));
    try {
      await page.goto(`${baseUrl}/__support-whitespace-test`, { waitUntil: "domcontentloaded" });
      await page.locator("#root > *").waitFor({ state: "attached", timeout: 15_000 });
      await page.getByRole("button", { name: "新建工单" }).click();
      await page.waitForTimeout(500);
      const dialog = page.locator(".ant-modal").last();
      await dialog.waitFor({ state: "visible" });
      await dialog.getByLabel("主题").fill("   ");
      await dialog.getByLabel("问题描述").fill("   ");
      await dialog.getByLabel("客户 ID").fill("   ");
      await dialog.getByLabel("客户名称").fill("   ");
      await dialog.getByRole("button", { name: "创建工单" }).click();
      await expectNoRequest(page);
      await dialog.getByText("主题", { exact: true }).waitFor();

      await dialog.getByLabel("主题").fill("  支付未到账  ");
      await dialog.getByLabel("问题描述").fill("  客户支付后订单仍未更新。  ");
      await dialog.getByLabel("客户 ID").fill("  customer-1  ");
      await dialog.getByLabel("客户名称").fill("  示例客户  ");
      await dialog.getByRole("button", { name: "创建工单" }).click();
      await page.waitForFunction(() => window.__supportCreatePayloads?.length === 1);
      const payload = await page.evaluate(() => window.__supportCreatePayloads?.[0]);
      expect(payload).toMatchObject({ subject: "支付未到账", description: "客户支付后订单仍未更新。", customerId: "customer-1", customerName: "示例客户" });
    } finally {
      if (!fixtureModuleResponses.length) console.error("support-whitespace-module-response-missing");
      await page.close();
    }
  }, 60_000);
});

async function expectNoRequest(page: import("playwright").Page) {
  await page.waitForTimeout(100);
  const payloads = await page.evaluate(() => window.__supportCreatePayloads ?? []);
  expect(payloads).toHaveLength(0);
}

declare global {
  interface Window { __supportCreatePayloads?: Array<{ subject: string; description: string; customerId?: string; customerName?: string; idempotencyKey: string }> }
}
