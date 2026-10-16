import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
            import '/src/styles.css';
            window.__ruleSyncCalls = 0;
            createRoot(document.getElementById('root')).render(
              React.createElement(RuleSyncStatusSection, {
                loading: false,
                statuses: [{ platform:'jd',label:'京东',officialUrl:'https://rule.jd.com/rule/list.action',configured:true,machineReadable:false,latestVersion:'0.1',sourceCheckedAt:'2026-10-06T00:00:00.000Z',ageHours:240,stale:true,state:'ready',reason:'规则来源已超过168小时未复核；已审核启用版本仍继续生效' }],
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
    const externalRequests: string[] = [];
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === baseUrl) return route.fallback();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    try {
      await page.goto(`${baseUrl}/__rule-sync-retry-test`);
      await expectText(page, "已启用");
      await page.getByText("来源待复核", { exact: true }).waitFor();
      expect(await page.getByText("新鲜", { exact: true }).count()).toBe(0);
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
      expect(externalRequests).toEqual([]);
      if (process.env.RULE_STATUS_ARTIFACTS) {
        const directory = resolve(process.env.RULE_STATUS_ARTIFACTS);
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: resolve(directory, "page.png"), fullPage: true });
        await writeFile(resolve(directory, "evidence.json"), JSON.stringify({ calls, pageErrors, externalRequests, bodyText: await page.locator("body").innerText() }, null, 2));
      }
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
