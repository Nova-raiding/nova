import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("manual store registration failure recovery", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-store-register-error-"));
    const entryPath = "/__store-register-error-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "isolated-store-register-error",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { StoreDirectorySection } from '/src/components/stores/StoreDirectorySection.tsx';
            window.__storeRegisterAttempts = 0;
            const register = async () => {
              window.__storeRegisterAttempts += 1;
              if (window.__storeRegisterAttempts === 1) throw new Error('当前角色缺少店铺登记权限');
            };
            const workspaces = [{ workspaceId: 'ws_test', enterpriseName: '隔离测试企业', status: 'active' }];
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(StoreDirectorySection, {
              storeDirectory: [{ platform: 'taobao', accountId: 'isolated-store-1', label: '隔离店铺', state: 'connected', dataMode: 'official_api', readable: true, writeEnabled: false, revision: 1, alias: '隔离店铺' }], canPlatformOps: true, workspaces, onRegisterManualStore: register,
              onSaveAlias: async () => false, onRevoke: async () => undefined,
            })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__store-register-error") return next();
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
    if (!address || typeof address === "string") throw new Error("Store registration test listener did not bind");
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

  it("shows a retryable modal error and retains entered values after the register call rejects", async () => {
    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await page.goto(`${baseUrl}/__store-register-error`);
      await page.getByRole("button", { name: "登记人工店铺", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "登记人工店铺" });
      await dialog.waitFor();
      await dialog.locator("#manual-store-workspace").click();
      await page.getByText("隔离测试企业 · ws_test", { exact: true }).click();
      await dialog.locator("#manual-store-platform").click();
      await page.getByText("淘宝", { exact: true }).click();
      await dialog.getByLabel("平台店铺账号 ID", { exact: true }).fill("isolated-store-1");
      await dialog.getByLabel("店铺别名（可选）", { exact: true }).fill("隔离店铺");
      await dialog.getByLabel("登记理由", { exact: true }).fill("为失败恢复回归保留的测试输入");
      await dialog.getByRole("button", { name: "确认登记", exact: true }).click();

      await dialog.getByRole("alert").getByText("当前角色缺少店铺登记权限", { exact: true }).waitFor();
      expect(await dialog.getByLabel("平台店铺账号 ID", { exact: true }).inputValue()).toBe("isolated-store-1");
      expect(await dialog.getByLabel("店铺别名（可选）", { exact: true }).inputValue()).toBe("隔离店铺");
      expect(await dialog.getByLabel("登记理由", { exact: true }).inputValue()).toBe("为失败恢复回归保留的测试输入");
      expect(await page.evaluate(() => (window as any).__storeRegisterAttempts)).toBe(1);

      await dialog.getByRole("button", { name: "确认登记", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      expect(await page.evaluate(() => (window as any).__storeRegisterAttempts)).toBe(2);
      expect(pageErrors).toEqual([]);
    } finally { await page.close(); }
  }, 45_000);

  it("keeps manual registration and alias edit limits aligned with the 40-character server rule", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/__store-register-error`);
      await page.getByRole("button", { name: "登记人工店铺", exact: true }).click();
      const registrationDialog = page.getByRole("dialog", { name: "登记人工店铺" });
      await registrationDialog.waitFor();
      const manualAlias = registrationDialog.getByLabel("店铺别名（可选）", { exact: true });
      expect(await manualAlias.getAttribute("maxlength")).toBe("40");
      expect(await registrationDialog.getByText("最多 40 个可见字符，与平台店铺别名规则一致。", { exact: true }).count()).toBe(1);
      await page.keyboard.press("Escape");
      await registrationDialog.waitFor({ state: "detached" });

      await page.getByRole("button", { name: "改别名", exact: true }).click();
      const editedAlias = page.locator("#store-display-alias");
      await editedAlias.waitFor({ state: "visible" });
      expect(await editedAlias.getAttribute("maxlength")).toBe("40");
      expect(await page.locator("#store-display-alias-limit").textContent()).toBe("最多 40 个可见字符，与平台店铺别名规则一致。");
    } finally { await page.close(); }
  }, 45_000);
});

function join(...parts: string[]) { return parts.join("/"); }
