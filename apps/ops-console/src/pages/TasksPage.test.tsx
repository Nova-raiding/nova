import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

vi.mock("../components/stores/ProductSpreadsheetImport.js", () => ({
  ProductSpreadsheetImport: () => null,
}));
vi.mock("../components/tasks/AlertFiltersSection", () => ({
  AlertFiltersSection: () => <div data-testid="platform-alert-filters" />,
}));
vi.mock("../components/tasks/MarketingQueueFiltersSection", () => ({
  MarketingQueueFiltersSection: () => <div data-testid="marketing-queue-filters" />,
}));
vi.mock("../components/tasks/OperationalGovernanceSection", () => ({
  OperationalGovernanceSection: () => <div data-testid="content-governance">内容治理区</div>,
}));

import { TasksPage } from "./TasksPage.js";

function tasksModel(options: {
  error?: string;
  canReadCustomerContent?: boolean;
  canReadMarketingQueue?: boolean;
  canReadPlatformMarketing?: boolean;
} = {}) {
  return {
    authorization: {
      scope: { kind: "workspace", id: "ws-test" },
      can: (capability: string) =>
        capability === "marketing.summary.read" ? options.canReadPlatformMarketing === true
          : capability === "marketing.queue.read" && options.canReadMarketingQueue === true,
      canAny: (capabilities: readonly string[]) => capabilities.some((capability) =>
        (capability === "marketing.queue.read" && options.canReadMarketingQueue === true)
        || (capability === "customer.content.read" && options.canReadCustomerContent === true)),
    },
    dataSetError: () => options.error,
    loading: false,
    load: vi.fn(async () => undefined),
    queueFilters: { state: "failed" },
    setQueueFilters: vi.fn(),
    alertFilters: {},
    setAlertFilters: vi.fn(),
    storeDirectory: [],
    canQueue: options.canReadCustomerContent === true,
    opsSession: { workspace_id: "ws-test" },
  } as unknown as OpsConsoleModel;
}

describe("TasksPage", () => {
  it("renders the task page title and does not present a failed read as an empty queue", () => {
    const html = renderToStaticMarkup(<TasksPage model={tasksModel({ error: "任务数据读取失败" })} />);

    expect(html).toContain("任务与内容");
    expect(html).toContain("任务数据读取失败");
    expect(html).toContain("先修复数据读取问题并重试；空列表不能解释为没有任务。");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("暂无任务");
  });

  it("shows customer content governance only when its read capability is present", () => {
    const allowed = renderToStaticMarkup(<TasksPage model={tasksModel({ canReadCustomerContent: true, canReadMarketingQueue: true })} />);
    const contentReadOnly = renderToStaticMarkup(<TasksPage model={tasksModel({ canReadCustomerContent: true })} />);
    const denied = renderToStaticMarkup(<TasksPage model={tasksModel({ canReadPlatformMarketing: true })} />);

    expect(allowed).toContain('data-testid="content-governance"');
    expect(allowed).toContain('data-testid="marketing-queue-filters"');
    expect(allowed).not.toContain('data-testid="platform-alert-filters"');
    expect(contentReadOnly).toContain('data-testid="content-governance"');
    expect(contentReadOnly).not.toContain('data-testid="marketing-queue-filters"');
    expect(denied).not.toContain('data-testid="content-governance"');
    expect(denied).not.toContain('data-testid="marketing-queue-filters"');
    expect(denied).toContain('data-testid="platform-alert-filters"');
    expect(denied).toContain("平台运营使用聚合治理数据");
  });
});

const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
));

describe("TasksPage task_id query", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(resolve(tmpdir(), "ops-tasks-page-"));
    const entryPath = "/__entry-tasks-page.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "tasks-page-effect-test",
        resolveId(id) {
          if (id === entryPath) return `\0${entryPath}`;
          if (id === "../components/stores/ProductSpreadsheetImport.js") return "\0tasks-test-product-import";
          if (id === "../components/tasks/AlertFiltersSection") return "\0tasks-test-alert-filters";
          if (id === "../components/tasks/MarketingQueueFiltersSection") return "\0tasks-test-marketing-filters";
          if (id === "../components/tasks/OperationalGovernanceSection") return "\0tasks-test-governance";
        },
        load(id) {
          if (id === `\0${entryPath}`) return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { TasksPage } from '/src/pages/TasksPage.tsx';
            window.__taskPageReads = [];
            window.__taskPageFilters = [];
            const model = {
              authorization: { scope: { kind: 'workspace', id: 'ws-test' }, can: () => false, canAny: () => false },
              dataSetError: () => undefined,
              loading: false,
              load: async options => { window.__taskPageReads.push(options); },
              queueFilters: { state: 'failed' },
              setQueueFilters: filters => { window.__taskPageFilters.push(filters); },
              alertFilters: {}, setAlertFilters: () => {}, storeDirectory: [], canQueue: false,
              opsSession: { workspace_id: 'ws-test' },
            };
            createRoot(document.getElementById('root')).render(React.createElement(TasksPage, { model }));
          `;
          if (id === "\0tasks-test-product-import" || id === "\0tasks-test-alert-filters" || id === "\0tasks-test-marketing-filters" || id === "\0tasks-test-governance") return "export function ProductSpreadsheetImport(){return null} export function AlertFiltersSection(){return null} export function MarketingQueueFiltersSection(){return null} export function OperationalGovernanceSection(){return null}";
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__tasks-page-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("TasksPage test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("applies a trimmed task_id filter and loads the task page with that filter", async () => {
    const page = await browser!.newPage();
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
    try {
      await page.goto(`${baseUrl}/__tasks-page-test?task_id=%20task-42%20`);
      await page.waitForFunction(() => (window as any).__taskPageReads?.length === 1, undefined, { timeout: 20_000 });
      await settle(page);

      const observed = await page.evaluate(() => ({
        filters: (window as any).__taskPageFilters,
        reads: (window as any).__taskPageReads,
      }));
      expect(observed.filters).toEqual([{ state: "failed", taskId: "task-42" }]);
      expect(observed.reads).toEqual([{ queueFilters: { state: "failed", taskId: "task-42" } }]);
      expect(browserErrors).toEqual([]);
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        filters: (window as any).__taskPageFilters,
        reads: (window as any).__taskPageReads,
        body: document.body.innerText,
      })).catch(() => undefined);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; browserErrors=${JSON.stringify(browserErrors)}; state=${JSON.stringify(diagnostics)}`);
    } finally {
      await page.close();
    }
  }, 60_000);
});
