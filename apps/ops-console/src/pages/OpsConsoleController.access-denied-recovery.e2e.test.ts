import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Ops access-denied recovery (local authorization fixture)", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(`${tmpdir()}/ops-access-denied-recovery-`);
    const entry = "/__access-denied-recovery-module.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      plugins: [{
        name: "ops-access-denied-recovery-test-entry",
        resolveId(id) { if (id === entry) return `\0${entry}`; },
        load(id) {
          if (id !== `\0${entry}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { createAuthorizationProjection } from '/src/authz/authorization.ts';
            import { accessDeniedRecoveryDomain } from '/src/pages/OpsConsoleController.tsx';
            import { useOpsNavigation } from '/src/navigation/useOpsNavigation.ts';
            import { AccessDeniedResult } from '/src/components/authz/AccessDeniedResult.tsx';

            function Harness() {
              const authorization = createAuthorizationProjection({
                actor_id: 'support-only', workspace_id: 'platform', roles: [], workspace_granted: true,
                capabilities: ['platform.summary.read', 'support.ticket.read'],
              }, true);
              const { activeDomain, navigate } = useOpsNavigation();
              const target = accessDeniedRecoveryDomain(authorization, 'platform');
              if (activeDomain !== 'users') return React.createElement('h1', null, '已到达有权限的总览');
              return React.createElement(AccessDeniedResult, {
                domainLabel: '用户中心', capability: 'identity.read', scope: authorization.scope,
                onBack: target ? () => navigate(target) : undefined,
                backLabel: target ? '返回' + (target === 'overview' ? '总览' : target) : undefined,
                onRefresh: () => {},
              });
            }
            createRoot(document.getElementById('root')).render(
              React.createElement(App, null, React.createElement(Harness)),
            );
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/ops/users")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then((output) => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(output);
            }).catch(next);
          });
        },
      }],
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Local test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("returns a support-only operator from /ops/users to an authorized overview", async () => {
    const page = await browser!.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/ops/users`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "返回总览" }).click();
    await page.waitForURL(`${baseUrl}/ops/overview`);
    expect(await page.getByRole("heading", { name: "已到达有权限的总览" }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
