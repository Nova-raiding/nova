import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Ops Console route navigation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-navigation-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-navigation-${randomUUID()}`;
    const harnessHtml = join(opsRoot, `${harnessName}.html`);
    const harnessEntry = join(opsRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/overview' + location.search)</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(harnessEntry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsSidebar } from '/src/components/OpsSidebar.tsx';
      import { useOpsNavigation } from '/src/navigation/useOpsNavigation.ts';
      function Probe() {
        const navigation = useOpsNavigation();
        return React.createElement(React.Fragment, null,
          React.createElement(OpsSidebar, { activeDomain: navigation.activeDomain, visibleDomains: ['overview', 'finance'], onNavigate: navigation.navigate }),
          React.createElement('button', { onClick: () => navigation.navigateWithQuery('finance', { accountId: 'acct-42' }) }, '打开指定账户'),
          React.createElement('main', { id: 'ops-main-content', tabIndex: -1 }, navigation.activeDomain)
        );
      }
      createRoot(document.getElementById('root')).render(React.createElement(Probe));
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
    if (!address || typeof address === "string") throw new Error("Ops navigation test listener did not bind");
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
          await Promise.all(harnessFiles.map((file) => rm(file, { force: true })));
        } finally {
          if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
        }
      }
    }
  }, 60_000);

  it("routes to the visible finance destination and restores the prior route with browser Back", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?workspaceId=workspace-a`);
      await expectDomain(page, "overview");

      const financeNavigation = page.getByRole("button", { name: "账务与退款" });
      await financeNavigation.focus();
      await financeNavigation.press("Enter");
      await expectDomain(page, "finance");
      await expect.poll(() => page.locator("#ops-main-content").evaluate((element) => element === document.activeElement)).toBe(true);
      expect(new URL(page.url()).pathname).toBe("/ops/finance");
      expect(new URL(page.url()).searchParams.get("workspaceId")).toBe("workspace-a");
      await expect.poll(() => page.getByRole("button", { name: "账务与退款" }).getAttribute("aria-current")).toBe("page");

      // Simulate an operator who has moved focus back into navigation before
      // using browser Back. A route restore must return focus to the new page.
      await financeNavigation.focus();
      await page.goBack();
      await expectDomain(page, "overview");
      await expect.poll(() => page.locator("#ops-main-content").evaluate((element) => element === document.activeElement)).toBe(true);
      expect(new URL(page.url()).pathname).toBe("/ops/overview");
      expect(new URL(page.url()).searchParams.get("workspaceId")).toBe("workspace-a");
      await expect.poll(() => page.getByRole("button", { name: "总览" }).getAttribute("aria-current")).toBe("page");

      await page.getByRole("button", { name: "打开指定账户", exact: true }).click();
      await expectDomain(page, "finance");
      expect(new URL(page.url()).pathname).toBe("/ops/finance");
      expect(new URL(page.url()).searchParams.get("workspaceId")).toBe("workspace-a");
      expect(new URL(page.url()).searchParams.get("accountId")).toBe("acct-42");
      await expect.poll(() => page.locator("#ops-main-content").evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
});

async function expectDomain(page: import("playwright").Page, domain: string) {
  await expect.poll(() => page.locator("#ops-main-content").textContent()).toBe(domain);
}
