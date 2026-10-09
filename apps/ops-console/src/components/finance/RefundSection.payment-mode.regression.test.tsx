import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("refund form payment mode gate", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-refund-payment-mode-"));
    const entryPath = "/__refund-payment-mode-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      plugins: [{
        name: "refund-payment-mode-test",
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
            if (req.url !== "/__refund-payment-mode-test") return next();
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
    if (!address || typeof address === "string") throw new Error("Refund payment-mode listener did not bind");
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

  async function openWithPayment(payment: Record<string, unknown>, status = 200): Promise<Page> {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(30_000);
    await page.route("**/api/healthz", route => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ data: { payment } }),
    }));
    await page.goto(`${baseUrl}/__refund-payment-mode-test`, { waitUntil: "commit" });
    await page.locator("#root").waitFor({ state: "attached" });
    return page;
  }

  it("explains manual_transfer and prevents the submit path", async () => {
    const page = await openWithPayment({ mode: "manual_transfer", provider_configured: false, effective: false, state: "not_configured", reasons: [] });
    try {
      await page.getByText("当前为人工转账收款，不支持自动退款", { exact: true }).waitFor();
      const submit = page.getByRole("button", { name: "创建退款" });
      await expectDisabled(submit);
      expect(await page.getByPlaceholder("例如 recharge_...").isDisabled()).toBe(true);
      expect(await page.getByPlaceholder("填写工单号和退款依据").isDisabled()).toBe(true);
      expect(await page.getByTestId("refund-calls").textContent()).toBe("[]");
      expect(await page.locator("html").getAttribute("data-refund-calls")).toBeNull();
    } finally { await page.close(); }
  }, 45_000);

  it("keeps the form usable only when healthz confirms an effective provider", async () => {
    const page = await openWithPayment({ mode: "provider", provider_configured: true, effective: true, state: "enabled", reasons: [] });
    try {
      await page.getByPlaceholder("例如 recharge_...").waitFor();
      const submit = page.getByRole("button", { name: "创建退款" });
      await submit.waitFor();
      expect(await submit.isDisabled()).toBe(false);
      await page.getByPlaceholder("例如 recharge_...").fill("recharge_provider_test");
      await page.getByPlaceholder("填写工单号和退款依据").fill("已确认的服务商退款");
      await submit.click();
      await page.waitForFunction(() => document.documentElement.dataset.refundCalls !== undefined);
      expect(await page.locator("html").getAttribute("data-refund-calls")).toBe('[{"orderId":"recharge_provider_test","reason":"已确认的服务商退款"}]');
    } finally { await page.close(); }
  }, 45_000);

  it("blocks a configured provider while the runtime gate is not effective", async () => {
    const page = await openWithPayment({ mode: "provider", provider_configured: true, effective: false, state: "configured_but_blocked", reasons: ["payment_production_gate_blocked"] });
    try {
      await page.getByText("支付服务商已配置但尚未就绪，退款已阻断", { exact: true }).waitFor();
      await page.getByText(/payment_production_gate_blocked/).waitFor();
      await expectDisabled(page.getByRole("button", { name: "创建退款" }));
      expect(await page.getByPlaceholder("例如 recharge_...").isDisabled()).toBe(true);
      expect(await page.getByTestId("refund-calls").textContent()).toBe("[]");
    } finally { await page.close(); }
  }, 45_000);

  it("fails closed when healthz is non-2xx even if its body looks ready", async () => {
    const page = await openWithPayment({ mode: "provider", provider_configured: true, effective: true, state: "enabled", reasons: [] }, 503);
    try {
      await page.getByText("尚未确认支付模式", { exact: true }).waitFor();
      await expectDisabled(page.getByRole("button", { name: "创建退款" }));
      expect(await page.getByPlaceholder("例如 recharge_...").isDisabled()).toBe(true);
      expect(await page.getByTestId("refund-calls").textContent()).toBe("[]");
    } finally { await page.close(); }
  }, 45_000);

  it("fails closed when provider readiness fields are missing", async () => {
    const page = await openWithPayment({ mode: "provider" });
    try {
      await page.getByText("尚未确认支付模式", { exact: true }).waitFor();
      await expectDisabled(page.getByRole("button", { name: "创建退款" }));
    } finally { await page.close(); }
  }, 45_000);
});

async function expectDisabled(button: Locator) {
  expect(await button.isDisabled()).toBe(true);
}
