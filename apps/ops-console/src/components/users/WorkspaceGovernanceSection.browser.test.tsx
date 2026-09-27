import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("workspace directory detail and governance dialogs", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-workspace-dialog-"));
    const entryPath = "/__workspace-dialog-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "isolated-workspace-dialog",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { WorkspaceGovernanceSection } from '/src/components/users/WorkspaceGovernanceSection.tsx';
            const row = { workspaceId: 'ws_dialog', enterpriseName: '测试企业', status: 'active', planName: 'Starter', monthlyPriceCny: 199, usedTasks: 0, includedTasks: 30, subscriptionStatus: 'trialing', memberCount: 1 };
            const model = {
              workspaceDirectory: { items: [row], total: 1, offset: 0, limit: 20, hasMore: false },
              workspaceDirectoryLoading: false, workspaceDirectoryError: '',
              dataSetError() { return ''; }, loadWorkspaceDirectory: async () => true,
              authorization: { can: capability => capability === 'workspace.status.update' || capability === 'commercial.entitlement.read' },
              opsSession: { workspace_id: 'ws_other' }, changeWorkspaceStatus: async () => true,
            };
            const entitlementClient = { entitlements: async workspaceId => ({ items: [{ id: 'ces_live_growth', workspaceId, skuCode: 'growth', snapshotVersion: 'v1', status: 'active', periodLabel: '2026-09-01 / 2026-10-01', brandLimit: 1, storeLimit: 1, storageLabel: null, serviceSummary: null, sourceOrderId: 'order_live_growth', sourceOrderStatus: 'paid', updatedAt: '2026-09-01' }], total: 1, truncated: false, nextCursor: null }) };
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(WorkspaceGovernanceSection, { model, entitlementClient })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__workspace-dialog-test") return next();
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
    if (!address || typeof address === "string") throw new Error("Workspace dialog listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("keeps the read-only detail separate from the tenant status action", async () => {
    if (!browser) throw new Error("Browser did not start");
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(10_000);
    try {
      await page.goto(`${baseUrl}/__workspace-dialog-test`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /详\s*情/u }).click();
      const detail = page.getByRole("dialog", { name: "工作区详情" });
      await detail.waitFor();
      expect(await detail.getByText("旧版套餐快照").count()).toBe(1);
      await detail.getByText("V2 权益快照（服务端）").waitFor();
      await detail.getByText("成长版（growth）").waitFor();
      expect(await detail.getByText("生效中").count()).toBe(1);
      expect(await detail.getByText("ces_live_growth").count()).toBe(1);
      expect(await detail.getByText("order_live_growth").count()).toBe(1);
      expect(await detail.getByText("已支付").count()).toBe(1);
      expect(await page.getByRole("dialog", { name: "停用租户" }).count()).toBe(0);
      await detail.getByRole("button", { name: "关闭" }).click();
      await page.getByRole("button", { name: "停用租户" }).click();
      await page.locator(".ant-modal").waitFor();
      expect(await page.locator(".ant-modal").getByText("停用后该租户成员将无法继续访问").count()).toBe(1);
      expect(await page.getByRole("dialog", { name: "工作区详情" }).count()).toBe(0);
    } finally { await page.close(); }
  }, 60_000);
});
