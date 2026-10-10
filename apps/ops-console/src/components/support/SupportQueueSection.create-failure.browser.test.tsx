import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("support ticket create failure feedback", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-create-failure-"));
    const entryPath = "/__support-create-failure-entry.tsx";
    // Vite's root is the ops-console package root so /src/... resolves to its
    // actual source tree (the test itself lives four directories below it).
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    vite = await createServer({
      configFile: false,
      root: appRoot,
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [react(), {
        name: "support-create-failure-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useRef, useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { SupportQueueSection } from '/src/components/support/SupportQueueSection.tsx';
            function Harness() {
              const [attempts, setAttempts] = useState(0);
              const [mutating, setMutating] = useState(false);
              const failNext = useRef(false);
              window.__failNextSupportCreate = () => { failNext.current = true; };
              const model = {
                workspaceId: 'ws_test', tickets: [], filters: { query: '' }, loading: false, loadingMore: false,
                detailLoading: false, mutating, error: '', hasMore: false, setFilters: () => {}, reload: async () => {},
                loadMore: async () => {}, selectTicket: async () => {}, clearSelection: () => {},
                create: async (payload) => {
                  if (!window.__supportCreatePayloads) window.__supportCreatePayloads = [];
                  window.__supportCreatePayloads.push(payload);
                  setMutating(true);
                  await new Promise(resolve => setTimeout(resolve, 300));
                  setMutating(false);
                  setAttempts(current => current + 1);
                  if (attempts === 0 || failNext.current) { failNext.current = false; throw new Error('服务端拒绝创建工单'); }
                }, assign: async () => {}, transition: async () => {}, comment: async () => {},
                reportLoading: false, loadReport: async () => {},
              };
              return React.createElement(App, null,
                React.createElement(SupportQueueSection, { model, canMutate: true }),
                React.createElement('output', { 'data-testid': 'attempts' }, String(attempts)));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__support-create-failure-test")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support create regression listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("shows mutation failure in the open dialog and retries with the entered values", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    const fixtureModuleResponses: Array<{ url: string; status: number }> = [];
    const fixtureDiagnostics: { failed: string[]; errors: string[]; consoleErrors: string[] } = { failed: [], errors: [], consoleErrors: [] };
    page.on("requestfailed", request => fixtureDiagnostics.failed.push(`${request.url()} ${request.failure()?.errorText ?? "unknown"}`));
    page.on("response", response => {
      if (response.url().includes("/src/components/support/SupportQueueSection.tsx")) {
        fixtureModuleResponses.push({ url: response.url(), status: response.status() });
      }
    });
    page.on("pageerror", error => fixtureDiagnostics.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") fixtureDiagnostics.consoleErrors.push(message.text()); });
    await page.addInitScript(() => window.addEventListener("error", event => {
      (window.__supportCreateWindowErrors ??= []).push(`${event.filename}:${event.lineno}:${event.colno} ${event.message}`);
    }));
    try {
      await page.goto(`${baseUrl}/__support-create-failure-test`, { waitUntil: "commit", timeout: 60_000 });
      const createButton = page.getByRole("button", { name: "新建工单", exact: true });
      try {
        await createButton.waitFor({ state: "visible", timeout: 60_000 });
      } catch (cause) {
        const runtime = await page.evaluate(() => ({
          readyState: document.readyState,
          root: document.querySelector("#root")?.innerHTML ?? "",
          resources: performance.getEntriesByType("resource").map(entry => entry.name),
          windowErrors: window.__supportCreateWindowErrors ?? [],
        })).catch(() => ({ readyState: "unavailable", root: "<root unavailable>", resources: [] as string[], windowErrors: [] as string[] }));
        throw new Error(`Support create fixture did not become interactive. ${JSON.stringify({ runtime, fixtureModuleResponses, fixtureDiagnostics })}`, { cause });
      }
      await createButton.click();
      const dialog = page.locator(".ant-modal").last();
      await dialog.waitFor({ state: "visible" });
      await dialog.getByLabel("主题").fill("支付未到账");
      await dialog.getByLabel("问题描述").fill("客户支付完成后账单仍未更新，需要检查回执状态。");
      await dialog.getByLabel("客户 ID").fill("customer-1");
      await dialog.getByLabel("客户名称").fill("示例客户");
      await dialog.getByRole("button", { name: "创建工单" }).click();
      await page.waitForTimeout(40);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "visible" });

      const alert = dialog.getByRole("alert");
      await alert.waitFor();
      expect(await alert.innerText()).toContain("创建工单失败");
      expect(await alert.innerText()).toContain("服务端拒绝创建工单");
      expect(await page.getByText("工单队列读取失败").count()).toBe(0);
      expect(await dialog.getByLabel("主题").inputValue()).toBe("支付未到账");

      await page.evaluate(() => window.__failNextSupportCreate?.());
      await dialog.getByRole("button", { name: "创建工单" }).click();
      await expect.poll(() => alert.innerText()).toContain("服务端拒绝创建工单");
      expect(await dialog.getByLabel("主题").inputValue()).toBe("支付未到账");

      await dialog.getByLabel("主题").fill("支付回执已核对");
      await dialog.getByRole("button", { name: "创建工单" }).click();
      await dialog.waitFor({ state: "detached" });
      expect(await page.getByTestId("attempts").textContent()).toBe("3");
      const payloads = await page.evaluate(() => window.__supportCreatePayloads?.map(({ subject, description, customerId, customerName, idempotencyKey }) => ({ subject, description, customerId, customerName, idempotencyKey })));
      expect(payloads).toHaveLength(3);
      expect(payloads?.[0]).toMatchObject({ subject: "支付未到账", description: "客户支付完成后账单仍未更新，需要检查回执状态。", customerId: "customer-1", customerName: "示例客户" });
      expect(payloads?.[1]).toMatchObject({ subject: "支付未到账", description: "客户支付完成后账单仍未更新，需要检查回执状态。", customerId: "customer-1", customerName: "示例客户" });
      expect(payloads?.[1]?.idempotencyKey).toBe(payloads?.[0]?.idempotencyKey);
      expect(payloads?.[2]).toMatchObject({ subject: "支付回执已核对", description: "客户支付完成后账单仍未更新，需要检查回执状态。", customerId: "customer-1", customerName: "示例客户" });
      expect(payloads?.[2]?.idempotencyKey).not.toBe(payloads?.[1]?.idempotencyKey);
      expect(fixtureModuleResponses).toHaveLength(1);
      expect(fixtureModuleResponses[0]?.status).toBe(200);
    } finally { await page.close(); }
  }, 120_000);
});

declare global {
  interface Window {
    __supportCreatePayloads?: Array<{ subject: string; description: string; customerId?: string; customerName?: string; idempotencyKey: string }>;
    __failNextSupportCreate?: () => void;
    __supportCreateWindowErrors?: string[];
  }
}
