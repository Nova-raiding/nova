import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("platform rule activation form validation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "rule-activation-validation-"));
    const entryPath = "/__rule-activation-validation-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "rule-activation-validation-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { RuleCenterSection } from '/src/components/tasks/RuleCenterSection.tsx';
            window.__ruleStatusUpdates = [];
            const model = {
              canRules: true,
              ruleMutationKey: undefined,
              rules: [{
                id: 'public_rule_1', packId: 'jd-pack', name: '标题规则', version: '1.0', status: 'draft', lifecycleStatus: 'draft',
                scope: location.search.includes('workspace') ? 'workspace' : 'platform', scopeValue: 'jd', targetId: 'jd', revision: 1, activationEligible: true,
                source: { kind: 'official', trust: 'verified', reference: 'https://rule.jd.com/rule/list.action', checkedAt: '2026-10-01T00:00:00.000Z', createdBy: 'signed-rule-sync' },
                createdBy: 'signed-rule-sync',
              }],
              updateRuleStatus: async (row, status) => { window.__ruleStatusUpdates.push({ packId: row.packId, status }); return true; },
              publishRuleDraft: async () => true,
            };
            createRoot(document.getElementById('root')).render(React.createElement(App, null,
              React.createElement(RuleCenterSection, { model })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__rule-activation-validation-test")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Rule activation regression listener did not bind");
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

  it("keeps validation feedback and consumes the invalid submit rejection", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await page.goto(`${baseUrl}/__rule-activation-validation-test`);
      await page.getByRole("button", { name: "审批并激活" }).click();
      const dialog = page.getByRole("dialog", { name: "审批并激活规则" });
      await dialog.getByRole("button", { name: "确认激活" }).click();
      await dialog.getByText("请填写审批人令牌").waitFor();
      expect(await dialog.isVisible()).toBe(true);
      await page.waitForTimeout(200);
      expect(pageErrors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("rejects a whitespace-only activation reason", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await page.goto(`${baseUrl}/__rule-activation-validation-test`);
      await page.getByRole("button", { name: "审批并激活" }).click();
      const dialog = page.getByRole("dialog", { name: "审批并激活规则" });
      await dialog.getByLabel("审批人令牌").fill("reviewer-token");
      await dialog.getByLabel("审批人 ID").fill("reviewer-1");
      await dialog.getByLabel("审批引用").fill("APR-123");
      await dialog.getByLabel("审批时间").fill("2026-10-09T00:00:00.000Z");
      await dialog.getByLabel("激活原因").fill("   \n  ");
      await dialog.getByRole("button", { name: "确认激活" }).click();
      await dialog.getByText("请输入激活原因").waitFor();
      expect(await dialog.isVisible()).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("confirms lifecycle changes with their scope and lets the operator cancel without writing", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await page.goto(`${baseUrl}/__rule-activation-validation-test`);
      page.setDefaultTimeout(5_000);
      await page.getByRole("button", { name: "标记过期" }).click();
      await page.getByText("将对所有商家应用", { exact: false }).waitFor({ timeout: 5_000 });
      await page.locator(".ant-modal-confirm-btns button").first().click();
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => window.__ruleStatusUpdates)).toEqual([]);

      await page.getByRole("button", { name: "停用" }).click();
      const disableConfirmation = page.getByRole("dialog", { name: "确认停用？" });
      await disableConfirmation.getByRole("button", { name: "确认停用" }).click();
      await page.waitForFunction(() => window.__ruleStatusUpdates?.length === 1, { timeout: 5_000 });
      expect(await page.evaluate(() => window.__ruleStatusUpdates)).toEqual([{ packId: "jd-pack", status: "inactive" }]);
      expect(pageErrors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("identifies workspace scope in the lifecycle confirmation", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__rule-activation-validation-test?scope=workspace`);
      await page.getByRole("button", { name: "标记过期" }).click();
      await page.getByText("将对当前工作区应用", { exact: false }).waitFor();
      await page.locator(".ant-modal-confirm-btns button").first().click();
    } finally { await page.close(); }
  }, 30_000);
});

declare global {
  interface Window {
    __ruleStatusUpdates?: Array<{ packId: string; status: string }>;
  }
}
