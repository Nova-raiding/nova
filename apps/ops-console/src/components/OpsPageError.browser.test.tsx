import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Ops permission error recovery", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-permission-recovery-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const harnessName = `.codex-ops-permission-recovery-${process.pid}`;
    const harnessHtml = join(opsRoot, `${harnessName}.html`);
    const harnessEntry = join(opsRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${harnessName}.tsx"></script></body></html>`);
    await writeFile(harnessEntry, `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from 'antd';
      import { OpsPageError } from '/src/components/OpsPageError.tsx';
      function Probe() {
        const [error, setError] = useState(Object.assign(new Error('当前账号缺少运营权限'), { code: 'FORBIDDEN' }));
        const [refreshing, setRefreshing] = useState(false);
        window.permissionRefreshCalls ??= 0;
        const refresh = () => {
          window.permissionRefreshCalls += 1;
          setRefreshing(true);
          return new Promise(resolve => { window.completePermissionRefresh = () => { setRefreshing(false); setError(undefined); resolve(); }; });
        };
        return React.createElement(App, null,
          error ? React.createElement(OpsPageError, { error, refreshingPermissions: refreshing, onRefreshPermissions: refresh }) : React.createElement('p', { role: 'status' }, '权限已刷新，可继续操作')
        );
      }
      createRoot(document.getElementById('root')).render(React.createElement(Probe));
    `);
    vite = await createServer({
      configFile: false,
      root: opsRoot,
      cacheDir: join(cacheDirectory, ".vite-cache"),
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Ops permission recovery test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    await Promise.all(harnessFiles.map((file) => rm(file, { force: true })));
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("locks duplicate permission refreshes and returns to the recovered state", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/.codex-ops-permission-recovery-${process.pid}.html`);
      const refresh = page.getByRole("button", { name: "刷新权限" });
      await refresh.waitFor();
      expect(await page.getByRole("alert").count()).toBe(1);

      await refresh.click();
      const pending = page.getByRole("button", { name: "正在刷新权限" });
      await pending.waitFor();
      expect(await pending.isDisabled()).toBe(true);
      expect(await page.evaluate(() => window.permissionRefreshCalls)).toBe(1);

      await page.evaluate(() => window.completePermissionRefresh?.());
      await page.getByRole("status").getByText("权限已刷新，可继续操作").waitFor();
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(await page.evaluate(() => window.permissionRefreshCalls)).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);
});

declare global {
  interface Window {
    permissionRefreshCalls: number;
    completePermissionRefresh?: () => void;
  }
}
