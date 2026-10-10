import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("rule sync failure recovery in the browser", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(resolve(tmpdir(), "ops-rule-sync-retry-"));
    const entryPath = "/__rule-sync-retry-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "rule-sync-retry-fixture",
        resolveId(id) {
          if (id === entryPath) return `\0${entryPath}`;
        },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { RuleSyncStatusSection } from '/src/components/rules/RuleSyncStatusSection.tsx';
            window.__ruleSyncCalls = 0;
            createRoot(document.getElementById('root')).render(
              React.createElement(RuleSyncStatusSection, {
                loading: false,
                statuses: [],
                canSync: true,
                onRefresh: () => undefined,
                onSyncNow: async () => { window.__ruleSyncCalls += 1; return false; },
              }),
            );
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__rule-sync-retry-test") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then((output) => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(output);
            }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Rule sync browser fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("keeps failed sync visible and retries from the page", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await page.goto(`${baseUrl}/__rule-sync-retry-test`);
      const syncButton = page.getByRole("button", { name: "立即更新平台规则" });
      await syncButton.click();
      const failure = page.getByRole("alert").filter({ hasText: "规则同步未完成" });
      await failure.waitFor();
      await expectText(page, "请核对上方错误提示或同步配置，再重试。");

      await failure.getByRole("button", { name: "重试同步" }).click();
      await failure.waitFor();
      const calls = await page.evaluate(() => (window as any).__ruleSyncCalls);
      expect(calls).toBe(2);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});

async function expectText(page: import("playwright").Page, text: string) {
  await page.getByText(text).waitFor();
}

declare global {
  interface Window {
    __ruleSyncCalls: number;
  }
}
