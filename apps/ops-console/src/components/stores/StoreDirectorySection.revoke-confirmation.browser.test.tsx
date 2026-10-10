import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("store authorization revoke confirmation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-store-revoke-confirm-"));
    const entryPath = "/__store-revoke-confirm-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "isolated-store-revoke-confirm",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { StoreDirectorySection } from '/src/components/stores/StoreDirectorySection.tsx';
            const store = { platform: 'taobao', accountId: 'store-1', label: '撤销回归店铺', state: 'connected', dataMode: 'official_api', readable: true, writeEnabled: false, revision: 1 };
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(StoreDirectorySection, {
              storeDirectory: [store], canPlatformOps: true,
              onSaveAlias: async () => true,
              onRevoke: async () => { const response = await fetch('/__store-revoke', { method: 'POST' }); if (!response.ok) throw new Error('revoke failed'); },
            })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__store-revoke-confirm") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>window.__storeConfirmCount=0;document.addEventListener('click',event=>{const button=event.target.closest('button');if(button?.innerText.trim()==='确认撤销')window.__storeConfirmCount+=1},true)</script><script type="module" src="${entryPath}"></script></body></html>`;
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
    if (!address || typeof address === "string") throw new Error("Store revoke test listener did not bind");
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

  it("requires exactly one confirmation and sends exactly one revoke request", async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    let revokeRequests = 0;
    await page.route("**/__store-revoke", async route => {
      revokeRequests += 1;
      await route.fulfill({ status: 200, body: "{}", contentType: "application/json" });
    });
    try {
      await page.goto(`${baseUrl}/__store-revoke-confirm`);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      const dialog = dialogByTitle(page, "确认撤销平台授权？");
      await dialog.waitFor();
      expect(await page.locator('[role="dialog"]:visible').count()).toBe(1);
      await dialog.getByRole("button", { name: "确认撤销", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await page.evaluate(() => (window as any).__storeConfirmCount)).toBe(1);
      expect(revokeRequests).toBe(1);
    } finally { await context.close(); }
  }, 45_000);

  it("sends no revoke request when the operator cancels or presses Escape", async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    let revokeRequests = 0;
    await page.route("**/__store-revoke", async route => {
      revokeRequests += 1;
      await route.fulfill({ status: 200, body: "{}", contentType: "application/json" });
    });
    try {
      await page.goto(`${baseUrl}/__store-revoke-confirm`);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      const firstDialog = dialogByTitle(page, "确认撤销平台授权？");
      await firstDialog.waitFor();
      let cancelButton = firstDialog.getByRole("button", { name: /取消/u });
      if (await cancelButton.count() === 0) {
        // Ant Design may expose the cancel label with an inserted whitespace
        // node, so retain the semantic dialog boundary and fall back to the
        // rendered cancel text within its own footer.
        cancelButton = firstDialog.locator(".ant-modal-footer button").filter({ hasText: /取\s*消/u });
      }
      if (await cancelButton.count() === 0) {
        const footerButtons = await firstDialog.locator(".ant-modal-footer button").evaluateAll(buttons => buttons.map(button => ({
          text: button.textContent?.trim() ?? "",
          ariaLabel: button.getAttribute("aria-label"),
          title: button.getAttribute("title"),
          className: button.className,
          disabled: (button as HTMLButtonElement).disabled,
        })));
        throw new Error(`Revoke confirmation cancel button was not exposed by role; footer buttons: ${JSON.stringify(footerButtons)}`);
      }
      await cancelButton.first().click();
      await firstDialog.waitFor({ state: "hidden" });
      expect(revokeRequests).toBe(0);

      await page.getByRole("button", { name: "撤销", exact: true }).click();
      const secondDialog = dialogByTitle(page, "确认撤销平台授权？");
      await secondDialog.waitFor();
      await page.keyboard.press("Escape");
      await secondDialog.waitFor({ state: "hidden" });
      expect(revokeRequests).toBe(0);
    } finally { await context.close(); }
  }, 45_000);

  it("keeps the target and explains a failed revoke so the operator can retry", async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    let revokeRequests = 0;
    await page.route("**/__store-revoke", async route => {
      revokeRequests += 1;
      await route.fulfill({ status: revokeRequests === 1 ? 503 : 200, body: "{}", contentType: "application/json" });
    });
    try {
      await page.goto(`${baseUrl}/__store-revoke-confirm`);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      const dialog = dialogByTitle(page, "确认撤销平台授权？");
      await dialog.getByRole("button", { name: "确认撤销", exact: true }).click();
      await dialog.getByRole("alert").getByText("revoke failed", { exact: true }).waitFor();
      expect(await dialog.getByText("撤销回归店铺", { exact: false }).count()).toBe(1);
      const confirm = dialog.getByRole("button", { name: /撤销/u });
      await confirm.waitFor({ state: "visible" });
      await confirm.click();
      await dialog.waitFor({ state: "hidden" });
      expect(revokeRequests).toBe(2);
      expect(pageErrors).toEqual([]);
    } finally { await context.close(); }
  }, 45_000);
});

function dialogByTitle(page: import("playwright").Page, title: string) {
  // rc-component's NODE_ENV=test useId stub reuses "test-id" across dialogs.
  return page.locator('[role="dialog"]').filter({ has: page.locator(".ant-modal-title").getByText(title, { exact: true }) });
}
