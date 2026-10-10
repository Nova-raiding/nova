import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
));

describe("brand store task route deep link", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(resolve(tmpdir(), "brand-store-task-route-"));
    const entryPath = "/__entry-brand-store-task-route.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "brand-store-task-route-test",
        resolveId(id) {
          if (id === entryPath) return `\0${entryPath}`;
          if (id === "../components/stores/ProductSpreadsheetImport.js") return "\0route-test-product-import";
          if (id === "../components/tasks/AlertFiltersSection") return "\0route-test-alert-filters";
          if (id === "../components/tasks/MarketingQueueFiltersSection") return "\0route-test-marketing-filters";
          if (id === "../components/tasks/OperationalGovernanceSection") return "\0route-test-governance";
        },
        load(id) {
          if (id === `\0${entryPath}`) return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { TasksPage } from '/src/pages/TasksPage.tsx';
            import { openBrandStore } from '/src/pages/brandStoreTaskNavigation.ts';
            import { urlForDomainWithQuery } from '/src/navigation/opsNavigation.ts';
            window.__routeLoads = [];
            window.__routeFilters = [];
            const scope = new URLSearchParams(window.location.search).get('testScope') === 'platform'
              ? { kind: 'platform', id: 'platform' }
              : { kind: 'workspace', id: 'ws-test' };
            const accountId = new URLSearchParams(window.location.search).get('testAccount') || 'store-1';
            const model = {
              authorization: { scope, can: () => false, canAny: () => false },
              dataSetError: () => undefined,
              loading: false,
              load: async options => { window.__routeLoads.push(options); },
              queueFilters: { state: 'failed' },
              setQueueFilters: filters => { window.__routeFilters.push(filters); },
              alertFilters: {}, setAlertFilters: () => {},
              storeDirectory: [{ workspaceId: 'ws-test', platform: 'taobao', accountId: 'store-1' }],
              canQueue: false,
              opsSession: { workspace_id: 'ws-test' },
            };
            if (!window.location.search) {
              window.history.replaceState(null, '', '/ops/stores');
              await openBrandStore(model, () => {}, 'taobao', 'store-1', (domain, query) => {
                const target = urlForDomainWithQuery(window.location, domain, query);
                window.history.pushState(null, '', target);
                window.__generatedRoute = target;
              });
            }
            if (accountId === '__none__') model.storeDirectory = [];
            createRoot(document.getElementById('root')).render(React.createElement(TasksPage, { model }));
          `;
          if (id.startsWith("\0route-test-")) return "export function ProductSpreadsheetImport(){return null} export function AlertFiltersSection(){return null} export function MarketingQueueFiltersSection(){return null} export function OperationalGovernanceSection(){return null}";
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__brand-store-task-route") && !req.url?.startsWith("/ops/tasks")) return next();
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
    if (!address || typeof address === "string") throw new Error("Brand store route test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("keeps the brand store platform/account in the generated URL and restores it after refresh", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/__brand-store-task-route`);
      await page.waitForFunction(() => Boolean((window as any).__generatedRoute), undefined, { timeout: 20_000 });
      const generated = await page.evaluate(() => (window as any).__generatedRoute as string);
      expect(generated).toBe("/ops/tasks?platform=taobao&accountId=store-1");

      await page.goto(`${baseUrl}${generated}`);
      await page.waitForFunction(() => (window as any).__routeLoads?.length === 1, undefined, { timeout: 20_000 });
      await settle(page);
      const restored = await page.evaluate(() => ({ filters: (window as any).__routeFilters, loads: (window as any).__routeLoads }));
      expect(restored.filters).toEqual([{ state: "failed", platform: "taobao", accountId: "store-1" }]);
      expect(restored.loads).toEqual([{ queueFilters: { state: "failed", platform: "taobao", accountId: "store-1" } }]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("does not apply a store account deep link in platform scope", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/__brand-store-task-route?platform=taobao&accountId=store-1&testScope=platform`);
      await page.waitForFunction(() => (window as any).__routeLoads?.length === 1, undefined, { timeout: 20_000 });
      const filters = await page.evaluate(() => (window as any).__routeFilters);
      expect(filters).toEqual([{ state: "failed", platform: undefined, accountId: undefined }]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("drops an account deep link absent from the authorized workspace store directory", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/__brand-store-task-route?platform=taobao&accountId=store-1&testAccount=__none__`);
      await page.waitForFunction(() => (window as any).__routeLoads?.length === 1, undefined, { timeout: 20_000 });
      const filters = await page.evaluate(() => (window as any).__routeFilters);
      expect(filters).toEqual([{ state: "failed", platform: undefined, accountId: undefined }]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("removes a rejected store link from the address while preserving unrelated query context", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/__brand-store-task-route?platform=taobao&accountId=store-1&testAccount=__none__&task_id=task-7&campaign=spring`);
      await page.waitForFunction(() => (window as any).__routeLoads?.length === 1, undefined, { timeout: 20_000 });
      await settle(page);

      const address = new URL(page.url());
      expect(address.searchParams.get("campaign")).toBe("spring");
      expect(address.searchParams.has("platform")).toBe(false);
      expect(address.searchParams.has("accountId")).toBe(false);
      expect(address.searchParams.get("testAccount")).toBe("__none__");
      expect(address.searchParams.get("task_id")).toBe("task-7");
      const filters = await page.evaluate(() => (window as any).__routeFilters);
      const loads = await page.evaluate(() => (window as any).__routeLoads);
      expect(filters).toEqual([{ state: "failed", platform: undefined, accountId: undefined, taskId: "task-7" }]);
      expect(loads).toEqual([{ queueFilters: { state: "failed", platform: undefined, accountId: undefined, taskId: "task-7" } }]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
