import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("StoragePage reconciliation failure recovery", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-storage-error-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-storage-error-${randomUUID()}`;
    const harnessHtml = join(opsRoot, `${harnessName}.html`);
    const harnessEntry = join(opsRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(harnessEntry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from 'antd';
      import { StoragePage } from '/src/pages/StoragePage.tsx';
      window.__storageLoads = 0;
      function Root() {
        const [failed, setFailed] = React.useState(true);
        const model = {
          authorization: { scope: { kind: 'platform' }, can: () => true },
          loading: false,
          dataSource: { fixtureDataPresent: false },
          dataSetError: () => failed ? '对账服务暂时不可用' : undefined,
          workspaceMetrics: undefined,
          storageReconciliationWorkspaces: [],
          load: async () => { window.__storageLoads += 1; setFailed(false); },
        };
        return React.createElement(App, null, React.createElement(StoragePage, { model }));
      }
      createRoot(document.getElementById('root')).render(React.createElement(Root));
    `, { flag: "wx" });
    vite = await createServer({
      configFile: false,
      root: opsRoot,
      cacheDir: join(cacheDirectory, ".vite-cache"),
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Storage error test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally {
        try { await Promise.all(harnessFiles.map(file => rm(file, { force: true }))); }
        finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
      }
    }
  }, 60_000);

  it("shows one failure and one retry action, then reloads the reconciliation data", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByText("对账结果加载失败").waitFor();
      expect(await page.getByText("对账结果加载失败", { exact: true }).count()).toBe(1);
      const retry = page.getByRole("button", { name: "重试加载对账结果" });
      expect(await retry.count()).toBe(1);
      await retry.click();
      await page.waitForFunction(() => window.__storageLoads === 1);
      await page.getByText('暂无可验证的对象清单对账结果').waitFor();
      expect(await page.getByText('对账结果加载失败').count()).toBe(0);
      expect(await page.getByRole('button', { name: '重试加载对账结果' }).count()).toBe(0);
    } finally { await page.close(); }
  }, 60_000);
});

declare global {
  interface Window { __storageLoads: number }
}
