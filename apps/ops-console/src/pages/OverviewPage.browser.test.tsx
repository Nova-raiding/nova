import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Ops Overview page read-only journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-overview-page-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-overview-${randomUUID()}`;
    const harnessHtml = join(opsRoot, `${harnessName}.html`);
    const harnessEntry = join(opsRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(harnessEntry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from 'antd';
      import { OverviewPage } from '/src/pages/OverviewPage.tsx';
      window.__overviewCalls = { loads: 0, navigations: [] };
      const canReadModel = new URLSearchParams(location.search).get('modelRead') === 'true';
      const model = {
        authorization: { can: capability => capability === 'model.status.read' && canReadModel },
        workspaceDirectory: { items: [], total: 0, merchantWorkspaceCount: 0 },
        platformFinanceSummary: undefined,
        platformMonthlyFinanceSummary: undefined,
        platformMonthlyFinanceMonth: '2026年10月',
        platformCommercialCatalog: [],
        platformModelUsageSummary: undefined,
        modelStatus: undefined,
        modelStatusLoading: false,
        dataSource: { fixtureDataPresent: false },
        dataSetError: method => method === 'platform.model.status' ? '本地fixture：状态尚未读取' : undefined,
        load: async () => { window.__overviewCalls.loads += 1; },
      };
      function Root() {
        return React.createElement(App, null,
          React.createElement(OverviewPage, {
            model,
            onNavigate: domain => window.__overviewCalls.navigations.push(domain),
            onNavigateWithQuery: (domain, query) => window.__overviewCalls.navigations.push({ domain, query }),
          })
        );
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
    if (!address || typeof address === "string") throw new Error("Ops overview test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await vite?.close();
      } finally {
        try {
          await Promise.all(harnessFiles.map(file => rm(file, { force: true })));
        } finally {
          if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
        }
      }
    }
  }, 60_000);

  it("shows measured zero and unknown costs honestly without model-read permission", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?modelRead=false`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("region", { name: "平台运营数据" }).waitFor();
      await expectMetric(page, "客户总数", "0");
      await expectMetric(page, "有效客户数", "0");
      await expectMetric(page, "接入费总收入", "—");
      await expectMetric(page, "累计平台消耗金额", "—");
      await page.getByText("当前账号没有模型状态读取权限").waitFor();
      expect(await page.getByText("真实生成尚未验证").count()).toBe(0);
      expect(await page.getByRole("button").count()).toBe(0);
      expect(await page.evaluate(() => window.__overviewCalls.navigations)).toEqual([]);
      expect(await page.evaluate(() => window.__overviewCalls.loads)).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("keeps missing model status fail-closed and retries only its read", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?modelRead=true`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByText("平台模型状态读取失败：状态不可用").waitFor();
      expect(await page.getByText("当前状态不能视为配置完成").count()).toBe(1);
      const retry = page.getByRole("button", { name: "重试加载平台模型状态" });
      await retry.click();
      await expect.poll(() => page.evaluate(() => window.__overviewCalls.loads)).toBe(1);
      expect(await page.evaluate(() => window.__overviewCalls.navigations)).toEqual([]);
      expect(await page.getByRole("button").count()).toBe(1);
    } finally {
      await page.close();
    }
  }, 60_000);
});

async function expectMetric(page: import("playwright").Page, label: string, expected: string) {
  const metric = page.locator(".ops-dashboard-metric").filter({ has: page.getByText(label, { exact: true }) });
  await metric.waitFor({ state: "visible" });
  expect(await metric.count()).toBe(1);
  expect(await metric.locator("strong").textContent()).toContain(expected);
}

declare global {
  interface Window {
    __overviewCalls: { loads: number; navigations: unknown[] };
  }
}
