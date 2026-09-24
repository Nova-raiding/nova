import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `refreshAlerts` is the only alert read that runs on a timer (`useAlertPolling`
 * drives it every 60s and on window focus), so it is the only one that can still
 * be on the wire when the authorization boundary moves. The coordinated load
 * commits through `OpsLoadCoordinator`, which `clearAuthorizationScopedData`
 * invalidates; without the same check the poll repaints the panel with alert
 * rows read under a JIT grant that has already lapsed (or a session that has
 * already logged out) — after the boundary clear emptied that panel.
 *
 * The model hook has no DOM-free renderer in this repo, so this drives the real
 * hook in a browser against a stubbed ops client.
 */
/** The harness hangs the model and the stub off `window`. */
interface HarnessWindow extends Window {
  model: { alerts: unknown[]; refreshAlerts: () => Promise<boolean>; clearAuthorizationScopedData: () => void };
  opsStub: { alertsPending: Array<{ resolve: (rows: unknown[]) => void }> };
  renderCount: number;
  pollResolve: (rows: unknown[]) => void;
}

describe("alert poll authorization boundary", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  const clientStub = `
    const stub = window.opsStub = { calls: [], alertsPending: [] };
    const session = {
      actor_id: 'actor-1', account_login: 'ops@example.test', workspace_id: 'ws-1',
      roles: ['ops_admin'], workspace_granted: true, workbench: 'workspace',
      capabilities: ['marketing.summary.read'],
    };
    const call = (method, params) => {
      stub.calls.push({ method, params });
      if (method === 'ops.session') return Promise.resolve(session);
      // Each alert read keeps its own resolver: the full load re-reads the same
      // dataset, so a shared slot would hand the test the wrong promise.
      if (method === 'ops.alerts.list') return new Promise(resolve => { stub.alertsPending.push({ resolve }); });
      return Promise.resolve(undefined);
    };
    export const rpc = (method, params) => call(method, params);
    export const rpcForWorkspace = (workspaceId, method, params) => call(method, params);
    export const opsRestPost = () => Promise.resolve(undefined);
    export const managedOpsSession = false;
    export const cookieOpsSession = true;
    export const hasOpsConnection = () => true;
    export const describeOpsError = error => (error && error.message) || '运营数据加载失败，请重试。';
    export const readOpsConnectionConfig = () => ({ apiBase: 'http://ops.test', workspaceId: 'ws-1', actorId: '', token: '', workbench: 'workspace' });
    export const clearOpsConnectionConfig = () => undefined;
    export const recordOpsBootstrapTrace = () => undefined;
    export const MAX_OPS_EXPORT_RESPONSE_BYTES = 16777216;
    export const OPS_EXPORT_TIMEOUT_MS = 30000;
  `;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-alert-boundary-"));
    const entryPath = "/__alert-boundary-entry.tsx";
    const stubId = "\0ops-client-stub";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "alert-boundary-harness",
        // `vite:resolve` runs before normal plugins, so a stub for a module that
        // exists on disk has to claim the specifier first.
        enforce: "pre",
        resolveId(id) {
          if (id === entryPath) return `\0${entryPath}`;
          // The browser re-requests a resolved virtual id in its encoded form.
          if (id === stubId || id === "/@id/__x00__ops-client-stub") return stubId;
          if (id.endsWith("/api/opsClient.js") || id.endsWith("/api/opsClient.ts")) return stubId;
          return null;
        },
        load(id) {
          if (id === stubId) return clientStub;
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { useOpsConsoleModel } from '/src/hooks/useOpsConsoleModel.ts';
            function Harness() {
              const model = useOpsConsoleModel();
              window.model = model;
              window.renderCount = (window.renderCount || 0) + 1;
              return React.createElement('div', null, 'alerts:' + model.alerts.length);
            }
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(Harness)));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__alert-boundary-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("alert boundary test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 180_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  async function mountedModel(page: Page) {
    page.setDefaultTimeout(20_000);
    await page.goto(`${baseUrl}/__alert-boundary-test`);
    await page.waitForFunction("window.model && window.model.opsSession");
  }

  /**
   * React commits on its own scheduler, so waiting a fixed number of frames can
   * still read the model object of an older render. Wait for a render instead.
   */
  async function alertsAfterNextRender(page: Page, renderCount: number) {
    await page.waitForFunction(`window.renderCount > ${renderCount}`, null, { timeout: 5_000 }).catch(() => undefined);
    return page.evaluate(() => (window as unknown as HarnessWindow).model.alerts.length);
  }

  it("drops an alert poll that resolves after the authorization boundary was cleared", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await mountedModel(page);
      // Let the mount fan-out settle, including its deferred (300ms) reads.
      await page.waitForTimeout(1_200);

      await page.evaluate(() => {
        const harness = window as unknown as HarnessWindow;
        harness.opsStub.alertsPending.length = 0;
        void harness.model.refreshAlerts();
      });
      await page.waitForFunction("window.opsStub.alertsPending.length === 1");
      await page.evaluate(() => {
        const harness = window as unknown as HarnessWindow;
        harness.pollResolve = harness.opsStub.alertsPending[0]!.resolve;
        harness.opsStub.alertsPending.length = 0;
      });

      // The JIT grant lapses (or the operator logs out): the console empties the
      // data it loaded under that grant and re-reads the server projection.
      const clearedAt = await page.evaluate(() => (window as unknown as HarnessWindow).renderCount);
      await page.evaluate(() => { (window as unknown as HarnessWindow).model.clearAuthorizationScopedData(); });
      expect(await alertsAfterNextRender(page, clearedAt)).toBe(0);

      // Only now does the poll's own response land.
      const resolveAt = await page.evaluate(() => (window as unknown as HarnessWindow).renderCount);
      await page.evaluate(() => (window as unknown as HarnessWindow).pollResolve([
        { id: "alert-1", severity: "high", title: "撤销后不应出现", entityType: "workspace", entityId: "ws-1", status: "open", observedAt: "2026-09-20T00:00:00.000Z", nextAction: "noop" },
      ]));

      expect(await alertsAfterNextRender(page, resolveAt)).toBe(0);
    } finally { await page.close(); }
  }, 90_000);
});
