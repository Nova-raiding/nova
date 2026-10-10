import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("user governance denied capability browser state", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(joinPath(tmpdir(), "ops-users-denied-"));
    const entryPath = "/__users-governance-denied-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("true"),
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("local"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("local"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "isolated-users-governance-denied",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { UsersPage } from '/src/pages/UsersPage.tsx';
            import { useOpsConsoleModel } from '/src/hooks/useOpsConsoleModel.ts';
            window.__rpcMethods = [];
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'fixture-token', actorId: 'fixture-operator'}));
            function Fixture() {
              const model = useOpsConsoleModel();
              return React.createElement(UsersPage, {model});
            }
            createRoot(document.getElementById('root')).render(
              React.createElement(App, null, React.createElement(Fixture))
            );
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__users-governance-denied-test")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Users denied browser listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it("shows a permission alert and keeps user reads unavailable on first render and permission refresh", async () => {
    if (!browser) throw new Error("Browser did not start");
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.route("**/api/mcp", async route => {
        const request = route.request().postDataJSON() as { id: string; method: string };
        await page.evaluate(method => window.__rpcMethods.push(method), request.method);
        const result = request.method === "ops.session" ? {
          actor_id: "fixture-operator",
          workspace_id: "",
          roles: [],
          workspace_granted: true,
          workbench: "platform",
          capabilities: [],
        } : null;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
      });
      await page.goto(`${baseUrl}/__users-governance-denied-test`, { waitUntil: "domcontentloaded" });
      await page.getByRole("alert").getByText("当前角色没有用户治理视图", { exact: true }).waitFor({ state: "visible" });
      expect(await page.getByRole("button", { name: "刷新用户治理权限" }).count()).toBe(1);
      expect(await page.getByRole("textbox").count()).toBe(0);
      expect(await page.getByRole("combobox").count()).toBe(0);
      expect(await page.getByRole("button", { name: /刷新用户目录|导出用户|按条件查询/u }).count()).toBe(0);
      expect(await page.evaluate(() => window.__rpcMethods)).toContain("ops.session");
      expect(await page.evaluate(() => window.__rpcMethods.filter(method => method === "ops.users.list"))).toEqual([]);

      const sessionsBeforeRefresh = await page.evaluate(() => window.__rpcMethods.filter(method => method === "ops.session").length);
      await page.getByRole("button", { name: "刷新用户治理权限" }).click();
      await page.waitForFunction(before => window.__rpcMethods.filter(method => method === "ops.session").length > before, sessionsBeforeRefresh);
      expect(await page.evaluate(() => window.__rpcMethods.filter(method => method === "ops.users.list"))).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/gu, "/");
}

declare global {
  interface Window {
    __rpcMethods: string[];
  }
}
