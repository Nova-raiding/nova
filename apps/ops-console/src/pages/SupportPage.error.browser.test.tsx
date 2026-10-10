import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("SupportPage error recovery", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-page-error-"));
    const entryPath = "/__support-page-error-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [react(), {
        name: "support-page-error-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { SupportPage } from '/src/pages/SupportPage.tsx';
            const model = {
              workspaceId: 'ws_local_fixture', tickets: [], filters: { query: '' }, loading: false,
              loadingMore: false, detailLoading: false, mutating: false, error: '本地 fixture 读取失败',
              hasMore: false, reportLoading: false, setFilters: () => {}, reload: async () => {},
              loadMore: async () => {}, selectTicket: async () => {}, clearSelection: () => {},
              create: async () => {}, assign: async () => {}, transition: async () => {}, comment: async () => {},
              loadReport: async () => {},
            };
            createRoot(document.getElementById('root')).render(React.createElement(App, null,
              React.createElement(SupportPage, { model, canMutate: false })
            ));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__support-page-error-test") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(output);
            }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support page test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("shows one queue error with one retry action instead of duplicate page and queue alerts", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    const runtimeErrors: string[] = [];
    page.on("pageerror", error => runtimeErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") runtimeErrors.push(message.text()); });
    try {
      await page.goto(`${baseUrl}/__support-page-error-test`, { waitUntil: "commit" });
      const error = page.locator(".ops-support-queue .ant-alert-error");
      try { await page.waitForFunction(() => Boolean(document.querySelector(".ops-support-queue .ant-alert-error"))); }
      catch {
        throw new Error(`Support page fixture did not reach its error state: ${JSON.stringify({ root: await page.locator("#root").innerHTML(), runtimeErrors })}`);
      }
      expect(await page.locator(".ops-support-queue .ant-alert-error").count()).toBe(1);
      expect(await error.locator("button").allTextContents()).toEqual(["刷新工单"]);
      expect(await error.evaluate(element => element.textContent)).toContain("本地 fixture 读取失败");
      expect(await page.locator("body").evaluate(element => element.textContent)).toContain("工单数据尚未取得，当前状态不能解释为没有客服工单。");
    } finally { await page.close(); }
  }, 30_000);
});
