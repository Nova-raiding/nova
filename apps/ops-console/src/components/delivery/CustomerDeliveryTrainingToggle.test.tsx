import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `ops.customer-delivery.training.complete` replaces `trainingEvidenceRefs`
 * with whatever the console sends, and the shipped handler forwards that list
 * straight into the delivery patch (apps/api/src/server.ts:14794,
 * packages/persistence/src/customer-delivery-repository.ts:522). The console's
 * coarse 客户培训 switch therefore has to carry the record's existing refs
 * forward, the same way `buildCustomerDeliveryProfilePatch` does for
 * `paymentEvidenceRefs`; sending `[]` silently destroys evidence that was
 * uploaded through the delivery detail drawer.
 *
 * antd's Select resolves its own dropdown, so the toggle can only be exercised
 * in a real browser. The section is mounted against a stub `onTrainingSave`
 * that records the forwarded refs.
 */
describe("customer delivery training toggle", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-training-toggle-"));
    const entryPath = "/__training-toggle-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "training-toggle-harness",
        resolveId(id) {
          if (id === entryPath) return `\0${entryPath}`;
        },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { CustomerDeliverySection } from '/src/components/delivery/CustomerDeliverySection.tsx';
            const h = window.trainingHarness = { calls: [] };
            window.record = {
              id: 'c-1', companyName: '示例企业', paymentStatus: 'paid', profile: true,
              integration: true, acceptance: true, training: false, videos: 0,
              revision: 3, trainingEvidenceRefs: ['asset:training-1', 'asset:training-2'],
            };
            createRoot(document.getElementById('root')).render(
              React.createElement(App, null,
                React.createElement(CustomerDeliverySection, {
                  records: [window.record],
                  onTrainingSave: (record, completed, evidenceAssetRefs) => {
                    h.calls.push({ completed, evidenceAssetRefs });
                    return Promise.resolve({ ...record, training: completed });
                  },
                })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__training-toggle-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("training toggle test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 180_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  async function openToggle(page: Page) {
    page.setDefaultTimeout(15_000);
    await page.goto(`${baseUrl}/__training-toggle-test`);
  }

  it("keeps the recorded training evidence refs when the table switch marks training complete", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await openToggle(page);
      await page.getByLabel("示例企业客户培训状态").click();
      await page.waitForSelector('.ant-select-item-option[title="已培训"]');
      // The dropdown is portalled without the app stylesheet, so Playwright's
      // hit-testing refuses it. Dispatch the same mouse sequence rc-select binds.
      await page.evaluate(() => {
        const option = document.querySelector<HTMLElement>('.ant-select-item-option[title="已培训"]');
        if (!option) throw new Error("training option not rendered");
        option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect.poll(() => page.evaluate("window.trainingHarness.calls.length")).toBe(1);
      expect(await page.evaluate("window.trainingHarness.calls")).toEqual([
        { completed: true, evidenceAssetRefs: ["asset:training-1", "asset:training-2"] },
      ]);
    } finally { await page.close(); }
  }, 60_000);
});
