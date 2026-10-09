import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("support filter refresh cursor boundary", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-filter-refresh-"));
    const entryPath = "/__support-filter-refresh-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "support-filter-refresh-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { useSupportDomain } from '/src/hooks/useSupportDomain.ts';
            const waits = ms => new Promise(resolve => setTimeout(resolve, ms));
            function Harness() {
              const client = {
                async list(input) {
                  window.__supportListCalls.push({ query: input.query || '', cursorId: input.cursor?.id || '' });
                  if (input.cursor) {
                    await waits(20);
                    return { items: [{ id: 'page-two', ticketNumber: 'PAGE-2', subject: '下一页', aggregate: false }] };
                  }
                  if (input.query === 'new-query') {
                    await waits(500);
                    return { items: [{ id: 'new-first', ticketNumber: 'NEW-1', subject: '新条件首屏', aggregate: false }], nextCursor: { id: 'new-cursor', createdAt: '2026-10-01T00:00:00.000Z' } };
                  }
                  return { items: [{ id: 'old-first', ticketNumber: 'OLD-1', subject: '旧条件首屏', aggregate: false }], nextCursor: { id: 'old-cursor', createdAt: '2026-09-01T00:00:00.000Z' } };
                },
                async get() { return undefined; }, async create() {}, async assign() {}, async transition() {}, async comment() {}, async report() {},
                async createCorrection() {}, async decideCorrection() {},
              };
              const model = useSupportDomain(client, 'ws_test');
              return React.createElement('main', null,
                React.createElement('output', { 'data-testid': 'state' }, JSON.stringify({ loading: model.loading, loadingMore: model.loadingMore, hasMore: model.hasMore, tickets: model.tickets.map(row => row.id) })),
                React.createElement('button', { onClick: () => model.setFilters({ ...model.filters, query: 'new-query' }) }, '切换筛选'),
                React.createElement('button', { disabled: !model.hasMore || model.loading || model.loadingMore, onClick: () => void model.loadMore() }, '加载更多'));
            }
            window.__supportListCalls = [];
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__support-filter-refresh-test")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support filter regression listener did not bind");
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

  it("invalidates old pages and blocks load more during the filter debounce and first-page request", async () => {
    const page = await browser!.newPage({ viewport: { width: 1000, height: 700 } });
    try {
      await page.goto(`${baseUrl}/__support-filter-refresh-test`);
      const state = page.getByTestId("state");
      await expect.poll(async () => JSON.parse((await state.textContent()) || "{}")).toMatchObject({ tickets: ["old-first"] });
      expect(await page.getByRole("button", { name: "加载更多" }).isEnabled()).toBe(true);

      await page.getByRole("button", { name: "切换筛选" }).click();
      await expect.poll(async () => JSON.parse((await state.textContent()) || "{}")).toMatchObject({ loading: true, hasMore: false, tickets: [] });
      expect(await page.getByRole("button", { name: "加载更多" }).isDisabled()).toBe(true);

      await expect.poll(async () => JSON.parse((await state.textContent()) || "{}")).toMatchObject({ hasMore: true, tickets: ["new-first"] });
      await page.getByRole("button", { name: "加载更多" }).click();
      await expect.poll(async () => JSON.parse((await state.textContent()) || "{}")).toMatchObject({ tickets: ["new-first", "page-two"] });
      const calls = await page.evaluate(() => window.__supportListCalls);
      expect(calls).toEqual([
        { query: "", cursorId: "" },
        { query: "new-query", cursorId: "" },
        { query: "new-query", cursorId: "new-cursor" },
      ]);
    } finally { await page.close(); }
  }, 30_000);
});

declare global {
  interface Window { __supportListCalls: Array<{ query: string; cursorId: string }> }
}
