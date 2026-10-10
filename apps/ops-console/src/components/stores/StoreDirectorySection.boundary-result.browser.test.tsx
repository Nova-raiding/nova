import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("manual store registration boundary result", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-store-boundary-result-"));
    const entryPath = "/__store-boundary-result-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "isolated-store-boundary-result",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { StoreDirectorySection } from '/src/components/stores/StoreDirectorySection.tsx';
            window.__storeBoundary = true;
            window.__storeRegisterAttempts = 0;
            const register = async () => {
              window.__storeRegisterAttempts += 1;
              return window.__storeBoundary;
            };
            const workspaces = [{ workspaceId: 'ws_test', enterpriseName: '隔离测试企业', status: 'active' }];
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(StoreDirectorySection, {
              storeDirectory: [], canPlatformOps: true, workspaces, onRegisterManualStore: register,
              onSaveAlias: async () => false, onRevoke: async () => undefined,
            })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__store-boundary-result") return next();
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
    if (!address || typeof address === "string") throw new Error("Store boundary test listener did not bind");
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

  it("closes after successful creation for either boundary state and explains when the boundary is inactive", async () => {
    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await page.goto(`${baseUrl}/__store-boundary-result`);

      const submitRegistration = async () => {
        await page.getByRole("button", { name: "登记人工店铺", exact: true }).click();
        const dialog = dialogByTitle(page, "登记人工店铺");
        await dialog.waitFor();
        await page.locator("#manual-store-workspace").focus();
        await page.locator("#manual-store-workspace").press("ArrowDown");
        await page.getByText("隔离测试企业 · ws_test", { exact: true }).click();
        await page.locator("#manual-store-platform").focus();
        await page.locator("#manual-store-platform").press("ArrowDown");
        await page.getByText("淘宝", { exact: true }).click();
        await page.locator("#manual-store-account").fill("isolated-store-1");
        await page.locator("#manual-store-reason").fill("边界响应状态回归");
        await page.getByRole("button", { name: "确认登记", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        return dialog;
      };

      await submitRegistration();
      const successNotice = page.getByRole("status").filter({ hasText: "人工店铺已登记" });
      await successNotice.getByText("该记录适用于当前人工运营边界。", { exact: false }).waitFor();
      expect(await page.evaluate(() => (window as any).__storeRegisterAttempts)).toBe(1);

      await page.evaluate(() => { (window as any).__storeBoundary = false; });
      await submitRegistration();
      await successNotice.getByText("当前部署的人工运营边界策略未启用。", { exact: false }).waitFor();
      expect(await successNotice.getByText("不会因此获得人工运营边界、平台授权或同步权限。", { exact: false }).count()).toBe(1);
      expect(await page.getByRole("alert").filter({ hasText: "人工店铺登记失败" }).count()).toBe(0);
      expect(await page.evaluate(() => (window as any).__storeRegisterAttempts)).toBe(2);
      expect(pageErrors).toEqual([]);
    } finally { await page.close(); }
  }, 45_000);
});

function join(...parts: string[]) { return parts.join("/"); }

function dialogByTitle(page: import("playwright").Page, title: string) {
  return page.locator('[role="dialog"]').filter({ has: page.locator(".ant-modal-title").getByText(title, { exact: true }) });
}
