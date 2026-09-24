import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { createServer, type ViteDevServer } from "vite";

/**
 * The `ops.workspaces.list` failure has to reach the model, not just a toast:
 * `workspaceRows` keeps its last successful page, so without a recorded error
 * the monthly-workspace table states 「共 0 个工作区」 over a read that failed.
 *
 * Chromium mounts the real hook and the real opsClient JSON-RPC reader. Only
 * the `/api/mcp` boundary is simulated; no application API or database is
 * started, and this is not OIDC/PostgreSQL acceptance.
 */
describe("workspace directory read failure", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-workspace-directory-"));
    const entryPath = "/__workspace-directory-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("oidc"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("oidc"),
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "workspace-directory-failure-state",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useEffect } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { useOpsConsoleModel } from '/src/hooks/useOpsConsoleModel.ts';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            function Probe() {
              const model = useOpsConsoleModel();
              useEffect(() => { if (model.opsSession) void model.loadWorkspaceDirectory(); }, [model.opsSession]);
              return React.createElement('div', null,
                React.createElement('span', { 'data-testid': 'session' }, model.opsSession ? 'ready' : 'pending'),
                React.createElement('span', { 'data-testid': 'error' }, model.workspaceDirectoryError || 'none'),
                React.createElement('span', { 'data-testid': 'dataset-error' }, model.dataSetError('ops.workspaces.list') || 'none'),
                React.createElement('span', { 'data-testid': 'rows' }, String(model.workspaceRows.length)),
                React.createElement('button', { type: 'button', onClick: () => void model.loadWorkspaceDirectory() }, '刷新月费工作区'));
            }
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(Probe)));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__workspace-directory-test") return next();
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
    if (!address || typeof address === "string") throw new Error("Workspace directory listener did not bind");
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

  const session = {
    actor_id: "ops-actor-1",
    account_login: "ops@example.com",
    workspace_id: "",
    roles: ["platform_ops"],
    capabilities: ["workspace.directory.read"],
    workbench: "platform",
    workspace_granted: true,
    scope: { type: "platform" },
  };
  const page = { items: [{ workspaceId: "ws_qinghe", enterpriseName: "青禾商贸", status: "active", planName: "5000 版本", monthlyPriceCny: 5000, usedTasks: 12, includedTasks: 100, subscriptionStatus: "active", memberCount: 3 }], offset: 0, limit: 20, hasMore: false, total: 1 };

  const respond = (route: Route, id: string, result: unknown) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
  });

  const text = (target: Page, testId: string) => target.getByTestId(testId).innerText();

  it("records the failure instead of only toasting it, and clears it on a recovered read", async () => {
    const target = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    // The probe's own read is request #1; the console's bootstrap fan-out asks
    // for the same dataset ~1.5s later and is request #2. Both fail before the
    // operator retries, so the retry is the only read that can clear either
    // record of the failure.
    let requests = 0;
    try {
      await target.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as { id: string; method: string };
        if (request.method === "ops.session") return respond(route, request.id, session);
        if (request.method === "ops.workspaces.list") {
          requests += 1;
          if (requests <= 2) {
            return route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "INTERNAL_ERROR", message: "工作区目录仓储不可用" } }),
            });
          }
          return respond(route, request.id, page);
        }
        return respond(route, request.id, {});
      });
      await target.goto(`${baseUrl}/__workspace-directory-test`);
      await expect.poll(() => text(target, "session"), { timeout: 20_000 }).toBe("ready");
      // The regression: a failed read left `workspaceDirectoryError` empty, so
      // the table rendered 0 rows and 「暂无月费工作区记录」 as if it were an answer.
      await expect.poll(() => text(target, "error"), { timeout: 20_000 }).toContain("运营服务暂时不可用");
      expect(await text(target, "rows")).toBe("0");
      // The console-wide fan-out recorded the same failure in the shared dataset
      // errors; wait for it so the retry below is unambiguous.
      await expect.poll(() => text(target, "dataset-error"), { timeout: 20_000 }).toContain("部分数据集刷新失败");

      await target.getByRole("button", { name: "刷新月费工作区", exact: true }).click();
      await expect.poll(() => text(target, "rows"), { timeout: 20_000 }).toBe("1");
      expect(await text(target, "error")).toBe("none");
      // ...including the stale dataset error, which only this retry can clear.
      await expect.poll(() => text(target, "dataset-error"), { timeout: 20_000 }).toBe("none");
    } finally { await target.close(); }
  }, 60_000);
});
