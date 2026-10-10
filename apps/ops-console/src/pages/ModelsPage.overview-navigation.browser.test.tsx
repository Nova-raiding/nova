import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("ModelsPage overview navigation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-models-navigation-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-models-${randomUUID()}`;
    const harnessHtml = join(opsRoot, `${harnessName}.html`);
    const harnessEntry = join(opsRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(harnessEntry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from 'antd';
      import { ModelsPage } from '/src/pages/ModelsPage.tsx';
      window.__modelNavigations = [];
      window.__modelMarkupCalls = { loads: 0, saves: [] };
      function Root() {
        const billingJourney = new URLSearchParams(location.search).get('billing') === '1';
        const relayBlocked = new URLSearchParams(location.search).get('billing') === 'blocked';
        const [modelMarkup, setModelMarkup] = React.useState(undefined);
        const [modelMarkupError, setModelMarkupError] = React.useState(billingJourney ? '倍率服务暂时不可用' : '');
        const [modelMarkupLoading, setModelMarkupLoading] = React.useState(false);
        const [modelMarkupReason, setModelMarkupReason] = React.useState('');
        const model = {
          authorization: { can: capability => capability === 'model.status.read' },
          canModelMarkup: billingJourney || relayBlocked,
          canModelMarkupUpdate: billingJourney || relayBlocked,
          modelMarkup, modelMarkupError, modelMarkupLoading, modelMarkupReason,
          modelStatus: billingJourney ? { state: 'ready', relay: { configured: true } } : relayBlocked ? { state: 'model_relay_blocked', relay: { configured: false } } : undefined,
          modelStatusLoading: false,
          dataSetError: () => undefined,
          dataSource: { fixtureDataPresent: false },
          setModelMarkup,
          setModelMarkupReason,
          loadModelMarkup: async () => {
            window.__modelMarkupCalls.loads += 1;
            setModelMarkupLoading(true);
            await Promise.resolve();
            setModelMarkup({ multiplier: 2.5, revision: 7 });
            setModelMarkupError('');
            setModelMarkupLoading(false);
          },
          saveModelMarkup: async () => {
            window.__modelMarkupCalls.saves.push({ multiplier: modelMarkup?.multiplier, reason: modelMarkupReason });
            setModelMarkup(current => current ? { ...current, revision: current.revision + 1 } : current);
          },
        };
        return React.createElement(App, null,
          React.createElement(ModelsPage, { model, onNavigate: domain => window.__modelNavigations.push(domain) })
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
    if (!address || typeof address === "string") throw new Error("Ops models test listener did not bind");
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

  it("lets users follow the page's Overview guidance in one click", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("heading", { name: "模型计费设置" }).waitFor();
      await page.getByRole("button", { name: "查看平台总览" }).click();
      await expect.poll(() => page.evaluate(() => window.__modelNavigations)).toEqual(["overview"]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("recovers the billing policy read before enabling an audited multiplier change", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?billing=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("alert").filter({ hasText: "倍率服务暂时不可用" }).waitFor();
      await expect.poll(() => page.getByRole("button", { name: "保存并生效" }).isDisabled()).toBe(true);

      const billingError = page.getByRole("alert").filter({ hasText: "倍率服务暂时不可用" });
      await billingError.getByRole("button", { name: /重\s*试/ }).click();
      await page.getByText("Revision 7").waitFor();
      const multiplier = page.getByRole("spinbutton", { name: "Token 计费倍率" });
      await multiplier.fill("3.5");
      await page.getByRole("textbox", { name: "Token 计费倍率变更原因" }).fill("依据已核验的供应商计价单调整");
      const save = page.getByRole("button", { name: "保存并生效" });
      await expect.poll(() => save.isEnabled()).toBe(true);
      await save.click();

      await page.getByText("Revision 8").waitFor();
      expect(await page.evaluate(() => window.__modelMarkupCalls)).toEqual({
        loads: 1,
        saves: [{ multiplier: 3.5, reason: "依据已核验的供应商计价单调整" }],
      });
    } finally {
      await page.close();
    }
  }, 60_000);

  it("keeps billing configuration closed when the platform relay readiness gate is blocked", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?billing=blocked`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByText("模型中转状态未通过读取门禁").waitFor();
      await page.getByText("模型中转未就绪").waitFor();
      expect(await page.getByRole("button", { name: "保存并生效" }).count()).toBe(0);
      expect(await page.evaluate(() => window.__modelMarkupCalls.loads)).toBe(0);
      expect(await page.evaluate(() => window.__modelMarkupCalls.saves)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

declare global {
  interface Window {
    __modelNavigations: string[];
    __modelMarkupCalls: { loads: number; saves: Array<{ multiplier?: number; reason: string }> };
  }
}
