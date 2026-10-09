import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("asynchronous mutation controls", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-async-mutation-state-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const harnessName = `.codex-async-mutation-${process.pid}`;
    const harnessHtml = join(opsRoot, `${harnessName}.html`);
    const harnessEntry = join(opsRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${harnessName}.tsx"></script></body></html>`);
    await writeFile(harnessEntry, `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from 'antd';
      import { ConfigurationCenterSection } from '/src/components/finance/ConfigurationCenterSection.tsx';
      import { BrandTreeSection } from '/src/components/stores/BrandTreeSection.tsx';
      const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
      function Probe() {
        const [rows, setRows] = useState([{ platform: 'taobao', enabled: true, displayName: '淘宝旧名', storeAlias: '旧别名', revision: 1, changeReason: '测试原因' }]);
        const [mode, setMode] = useState('config');
        window.configCalls ??= []; window.brandCalls ??= []; window.configPending ??= {}; window.brandPending ??= {};
        const model = { authorization: { can: () => true }, settings: undefined, platformRows: rows, setPlatformRows: setRows, platformOperations: [], orders: [], loading: false, saving: false, canPlatformOps: true, saveCommercial: async () => {}, savePlatform: row => { window.configCalls.push(row); const item = deferred(); window.configPending[row.platform] = item; return item.promise.then(() => setRows(current => current.map(value => value.platform === row.platform ? { ...row, revision: row.revision + 1 } : value))); }, dataSetError: () => undefined, load: async () => {} };
        const brands = [{ id: 'brand-a', title: '品牌 A', revision: 4, platforms: [] }, { id: 'brand-b', title: '品牌 B', revision: 8, platforms: [] }];
        const stores = [{ platform: 'jd', accountId: 'acct-1', label: '京东测试店', state: 'connected', dataMode: 'official_api', readable: true, writeEnabled: false, revision: 1 }];
        const bind = input => { window.brandCalls.push(input); const item = deferred(); window.brandPending[input.brandId] = item; return item.promise; };
        return React.createElement(App, null,
          React.createElement('button', { onClick: () => setMode('config') }, '配置模式'),
          React.createElement('button', { onClick: () => setMode('brand') }, '品牌模式'),
          mode === 'config' ? React.createElement(ConfigurationCenterSection, { model }) : React.createElement(BrandTreeSection, { brands, stores, canRead: true, canBind: true, onBindStore: bind })
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
    if (!address || typeof address === "string") throw new Error("async mutation test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    await Promise.all(harnessFiles.map(file => rm(file, { force: true })));
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("locks a platform row during save and accepts only one request for that revision", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/.codex-async-mutation-${process.pid}.html`);
      await page.getByText("配置中心", { exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole("tab", { name: "平台与店铺" }).click();
      const name = page.getByLabel("taobao 展示名称");
      await name.fill("淘宝新名称");
      const save = page.getByRole("button", { name: "保存" });
      await save.click();
      await expectDisabled(name);
      await expectDisabled(page.getByLabel("taobao 店铺别名"));
      await expectDisabled(page.getByLabel("taobao 变更原因"));
      await expectDisabled(page.getByRole("switch"));
      expect(await page.evaluate("window.configCalls.length")).toBe(1);
      await page.evaluate(() => (window as any).configPending.taobao.resolve());
      await expectEnabled(name);
      expect(await name.inputValue()).toBe("淘宝新名称");
    } finally { await page.close(); }
  }, 45_000);

  it("keeps different brand requests independent through interleaved success and failure", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/.codex-async-mutation-${process.pid}.html`);
      await page.getByText("配置中心", { exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole("button", { name: "品牌模式" }).click();
      await selectStore(page, "品牌 A待绑定店铺");
      await selectStore(page, "品牌 B待绑定店铺");
      const buttons = page.getByRole("button", { name: "绑定店铺" });
      await buttons.nth(0).click();
      await buttons.nth(1).click();
      await expect.poll(() => page.evaluate("window.brandCalls.length")).toBe(2);
      await page.evaluate(() => (window as any).brandPending["brand-a"].resolve(true));
      await expect.poll(() => buttons.nth(0).isEnabled()).toBe(true);
      await expectDisabled(buttons.nth(1));
      await expectDisabled(page.getByLabel("品牌 B待绑定店铺"));
      expect(await page.evaluate("window.brandCalls.length")).toBe(2);
      await page.evaluate(() => (window as any).brandPending["brand-b"].reject(new Error("B 的版本已变化")));
      await page.getByRole("alert").getByText("B 的版本已变化", { exact: true }).waitFor();
      await expect.poll(() => buttons.nth(1).isEnabled()).toBe(true);
      expect(await page.getByRole("alert").count()).toBe(1);
      await buttons.nth(1).click();
      await expect.poll(() => page.evaluate("window.brandCalls.length")).toBe(3);
      expect(await page.evaluate("window.brandCalls[2]")).toMatchObject({ brandId: "brand-b", platform: "jd", accountId: "acct-1" });
      expect(await page.evaluate("window.brandCalls.filter(call => call.brandId === 'brand-a').length")).toBe(1);
      await page.evaluate(() => (window as any).brandPending["brand-b"].resolve(true));
      await expect.poll(() => buttons.nth(1).isEnabled()).toBe(true);
    } finally { await page.close(); }
  }, 45_000);
});

async function selectStore(page: import("playwright").Page, label: string) {
  await page.getByLabel(label).click();
  await page.getByText("京东测试店（acct-1）", { exact: true }).last().click();
}
async function expectDisabled(locator: import("playwright").Locator) {
  await locator.waitFor();
  expect(await locator.isDisabled()).toBe(true);
}
async function expectEnabled(locator: import("playwright").Locator) {
  await locator.waitFor();
  await expect.poll(() => locator.isEnabled()).toBe(true);
}
