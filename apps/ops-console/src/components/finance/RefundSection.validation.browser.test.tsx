import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("refund reason form validation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-refund-validation-"));
    const entryPath = "/__refund-validation-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      plugins: [{
        name: "refund-validation-test",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App, Form } from 'antd';
            import { RefundSection } from '/src/components/finance/RefundSection.tsx';
            const calls = [];
            const model = {
              authorization: { scope: { kind: 'platform' } },
              refundForm: undefined,
              refund: async values => { calls.push(values); document.documentElement.dataset.refundCalls = JSON.stringify(calls); },
              canFinance: true,
              refundSubmitting: false,
            };
            function Harness() {
              const [refundForm] = Form.useForm();
              return React.createElement(App, null,
                React.createElement(RefundSection, { model: { ...model, refundForm } }),
                React.createElement('output', { 'data-testid': 'refund-calls' }, JSON.stringify(calls)));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === "/ops-test/healthz") {
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ data: { payment: { mode: "provider", provider_configured: true, effective: true, state: "enabled", reasons: [] } } }));
              return;
            }
            if (req.url !== "/__refund-validation-test") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(output);
            }).catch(next);
          });
        },
      }],
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Refund validation listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("blocks a whitespace-only reason before the refund callback", async () => {
    if (!browser) throw new Error("Chromium did not start");
    const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    try {
      await openRefundPage(page, baseUrl);
      const orderId = page.getByPlaceholder("例如 recharge_...");
      await orderId.fill("recharge_test_only");
      await page.getByPlaceholder("填写工单号和退款依据").fill("    ");
      await page.getByRole("button", { name: "创建退款" }).click();
      await page.getByText("请输入退款原因", { exact: true }).waitFor();
      expect(await page.getByTestId("refund-calls").textContent()).toBe("[]");
      expect(await page.locator("html").getAttribute("data-refund-calls")).toBeNull();
    } finally { await page.close(); }
  }, 45_000);

  it("blocks a whitespace-only order id before the refund callback", async () => {
    if (!browser) throw new Error("Chromium did not start");
    const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    try {
      await openRefundPage(page, baseUrl);
      await page.getByPlaceholder("例如 recharge_...").fill("   ");
      await page.getByPlaceholder("填写工单号和退款依据").fill("客户工单 1234，重复充值退款");
      await page.getByRole("button", { name: "创建退款" }).click();
      await page.getByText("请输入已到账的充值订单 ID", { exact: true }).waitFor();
      expect(await page.getByTestId("refund-calls").textContent()).toBe("[]");
      expect(await page.locator("html").getAttribute("data-refund-calls")).toBeNull();
    } finally { await page.close(); }
  }, 45_000);

  it("accepts a non-empty trimmed reason without imposing a client-only length rule", async () => {
    if (!browser) throw new Error("Chromium did not start");
    const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    try {
      await openRefundPage(page, baseUrl);
      await page.getByPlaceholder("例如 recharge_...").fill(" recharge_test_only ");
      await page.getByPlaceholder("填写工单号和退款依据").fill(" x ");
      await page.getByRole("button", { name: "创建退款" }).click();
      await page.waitForFunction(() => document.documentElement.dataset.refundCalls !== undefined);
      expect(await page.locator("html").getAttribute("data-refund-calls")).toBe('[{"orderId":"recharge_test_only","reason":"x"}]');
    } finally { await page.close(); }
  }, 45_000);
});

async function openRefundPage(page: Page, baseUrl: string) {
  await page.addInitScript((apiBase) => {
    localStorage.setItem("ops_connection_config_v1", JSON.stringify({
      apiBase,
      workspaceId: "",
      actorId: "fixture-platform-finance",
      token: "fixture-platform-token",
      workbench: "platform",
    }));
  }, `${baseUrl}/ops-test`);
  await page.goto(`${baseUrl}/__refund-validation-test`, { waitUntil: "domcontentloaded" });
}
