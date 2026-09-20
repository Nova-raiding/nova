import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const application = {
  application_id: "app_1",
  login: "new-customer@example.com",
  enterprise_name: "青禾商贸",
  contact_name: "张三",
  status: "merchant_pending",
  workspace_ids: [],
  created_at: "2026-09-19T02:00:00.000Z",
  updated_at: "2026-09-19T02:00:00.000Z",
  revision: 1,
};

/**
 * Chromium mounts the real component and the real opsClient REST reader. Only
 * the `/v1/ops/merchant-registration-applications` response is simulated: this
 * is UI regression evidence for the error state, not API or OIDC acceptance.
 */
describe("registration applications error state", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;
  const applicationsUrl = () => `${baseUrl}/api/v1/ops/merchant-registration-applications`;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-registration-apps-"));
    const entryPath = "/__registration-applications-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
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
        name: "registration-applications-error-state",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { RegistrationApplications } from '/src/components/users/UsersGovernanceWorkspace.tsx';
            sessionStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            const model = { authorization: { can: () => true } };
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(RegistrationApplications, { model })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__registration-applications-test") return next();
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
    if (!address || typeof address === "string") throw new Error("Registration applications listener did not bind");
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

  const fail = (route: Route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "入驻申请仓储不可用" } }),
  });
  const succeed = (route: Route, items: unknown[]) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: "registrations-1", data: { items } }),
  });

  // The card is mounted by text, not by the refresh button's accessible name:
  // Ant Design leaves the loading icon in the DOM, and its `aria-label="loading"`
  // then rides along in the button's computed name.
  async function open(page: Page) {
    await page.goto(`${baseUrl}/__registration-applications-test`);
    await page.getByText("刷新申请", { exact: true }).waitFor();
  }

  it("reports a failed read instead of rendering the table's empty placeholder", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.route(applicationsUrl(), route => fail(route));
      await open(page);
      // The failure must land as a persistent, focusable error surface.
      await expect.poll(() => page.locator('.ops-page-error[data-state="error"]').count()).toBe(1);
      expect(await page.getByText("无法加载运营数据", { exact: false }).count()).toBeGreaterThan(0);
      expect(await page.getByText("运营服务暂时不可用", { exact: false }).count()).toBeGreaterThan(0);
      // Regression: the table rendered "No data" / 「暂无数据」 over a 500.
      expect(await page.getByText("No data").count()).toBe(0);
      expect(await page.getByText("暂无数据").count()).toBe(0);
      expect(await page.getByText(/这不是空表/u).count()).toBe(1);
      // The transient toast is not the only signal that the read failed.
      await page.getByRole("button", { name: "重试加载运营数据", exact: true }).waitFor();
    } finally { await page.close(); }
  }, 45_000);

  it("retries the read and clears the failure once the API answers", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    let reading = true;
    try {
      await page.route(applicationsUrl(), route => reading ? fail(route) : succeed(route, [application]));
      await open(page);
      await expect.poll(() => page.locator('.ops-page-error[data-state="error"]').count()).toBe(1);
      reading = false;
      await page.getByRole("button", { name: "重试加载运营数据", exact: true }).click();
      await expect.poll(() => page.getByText("new-customer@example.com", { exact: false }).count()).toBe(1);
      await expect.poll(() => page.locator('.ops-page-error[data-state="error"]').count()).toBe(0);
      expect(await page.getByText(/这不是空表/u).count()).toBe(0);
    } finally { await page.close(); }
  }, 45_000);

  it("keeps a genuine empty answer as an empty state, not as a failure", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.route(applicationsUrl(), route => succeed(route, []));
      await open(page);
      await expect.poll(() => page.getByText("暂无入驻申请", { exact: false }).count()).toBe(1);
      expect(await page.locator('.ops-page-error[data-state="error"]').count()).toBe(0);
      expect(await page.getByText(/这不是空表/u).count()).toBe(0);
    } finally { await page.close(); }
  }, 45_000);
});
