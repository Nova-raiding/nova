import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("delivery account binding search results", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "delivery-account-search-"));
    const entryPath = "/__delivery-account-search-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "delivery-account-search-harness",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { CustomerDeliveryAccountBinding } from '/src/components/delivery/CustomerDeliveryAccountBinding.tsx';
            const record = { id:'delivery-1', companyName:'测试企业', paymentStatus:'paid', profile:true, integration:true, acceptance:true, training:true, videos:0, revision:1 };
            createRoot(document.getElementById('root')).render(React.createElement(App, null,
              React.createElement(CustomerDeliveryAccountBinding, {
                record,
                onList: async ({ search }) => ({ items: [{ workspaceId:'ws-1', accountId:'a-'+search, identityId:'i-'+search, login:search+'@example.test' }], nextCursor:'cursor-'+search }),
                onBind: async () => record,
                onBound: () => {},
              })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__delivery-account-search-test") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("delivery account search listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 180_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("clears stale accounts, selection, and cursor when the query changes", async () => {
    const page: Page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(15_000);
    try {
      await page.goto(`${baseUrl}/__delivery-account-search-test`, { waitUntil: "domcontentloaded" });
      const search = page.getByRole("searchbox", { name: "查找商家登录账号" });
      await search.fill("alpha");
      await page.getByRole("button", { name: "查询账号" }).click();
      await page.getByRole("button", { name: "加载更多账号" }).waitFor();
      await page.getByRole("combobox", { name: "选择生效账号" }).click();
      await page.getByText("alpha@example.test").click();
      await expect.poll(() => page.getByText("alpha@example.test").count()).toBeGreaterThan(0);

      await search.press("Escape");
      await search.fill("beta");
      await expect.poll(() => page.locator(".ant-select-selection-item").filter({ hasText: "alpha@example.test" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "加载更多账号" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "确认关联账号" }).count()).toBe(0);
    } finally { await page.close(); }
  }, 60_000);
});
