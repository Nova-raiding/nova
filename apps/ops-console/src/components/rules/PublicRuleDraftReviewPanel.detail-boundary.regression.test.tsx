import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const rule = {
  id: "public-rule-detail-1",
  platform: "pinduoduo",
  pack_id: "pdd-delivery",
  name: "拼多多发货规则",
  version: "1.2.0",
  status: "draft",
  source: { kind: "official", reference: "https://example.test/pdd/rules", checked_at: "2026-10-01T08:00:00.000Z", trust: "manual_pending_review" },
  checks: { dispatch_deadline_hours: 48 },
  checksum: "a".repeat(64),
  checksum_valid: true,
  created_by: "operator-writer",
  created_at: "2026-10-01T08:00:00.000Z",
  revision: 3,
};

const audit = [{
  id: "audit-rule-detail-1",
  action: "draft_created",
  actor_id: "operator-writer",
  reason: "导入官方规则候选",
  occurred_at: "2026-10-01T08:05:00.000Z",
  data: { source: "manual-upload" },
}];

/**
 * UI-boundary regression only: the real component and browser render, while
 * the opsClient RPC boundary is replaced with deterministic responses. This
 * does not claim API, MCP transport, authorization, or persistence acceptance.
 */
describe("public rule draft detail UI boundary", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-rule-detail-boundary-"));
    const entryPath = "/__public-rule-detail-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "public-rule-detail-rpc-mock",
        enforce: "pre",
        transform(code: string, id: string) {
          if (id.includes("PublicRuleDraftReviewPanel.tsx")) {
            const rpcImport = 'import { rpc } from "../../api/opsClient.js";';
            if (!code.includes(rpcImport)) throw new Error("Could not locate the PublicRuleDraftReviewPanel RPC boundary");
            return code.replace(rpcImport, "const rpc = (method, params, options) => window.__publicRuleRpcMock(method, params, options);");
          }
        },
        resolveId(id: string) {
          if (id === entryPath) return `\0${entryPath}`;
        },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { PublicRuleDraftReviewPanel } from '/src/components/rules/PublicRuleDraftReviewPanel.tsx';
            const allowed = new Set(['rule.read', 'rule.update', 'rule.publish.approve']);
            const authorization = {
              scope: { kind: 'platform' },
              can: capability => allowed.has(capability),
            };
            createRoot(document.getElementById('root')).render(
              React.createElement(App, null,
                React.createElement(PublicRuleDraftReviewPanel, { authorization }),
              ),
            );
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__public-rule-detail-test") return next();
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
    if (!address || typeof address === "string") throw new Error("Rule detail test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  async function openPanel(page: Page, detailResponse: unknown) {
    await page.addInitScript(({ ruleValue, auditValue, detailValue }) => {
      localStorage.setItem("ops_connection_config_v1", JSON.stringify({ apiBase: "/api", workspaceId: "ui-boundary-workspace", workbench: "platform" }));
      window.__publicRuleRpcMock = async (method: string) => {
        if (method === "ops.rules.public.drafts.list") return { items: [ruleValue] };
        if (method === "ops.rules.public.drafts.get") return detailValue;
        throw new Error(`Unexpected RPC method: ${method}`);
      };
    }, { ruleValue: rule, auditValue: audit, detailValue: detailResponse });
    await page.goto(`${baseUrl}/__public-rule-detail-test`);
    await page.waitForTimeout(1_000);
    const initialText = await page.locator("body").innerText();
    if (!initialText.includes(rule.name)) throw new Error(`Draft list did not render. Browser text: ${initialText}`);
    await page.getByText(rule.name, { exact: true }).waitFor();
    await page.getByRole("button", { name: `查看${rule.name}审核详情` }).click();
  }

  it("renders a valid rule detail and its audit history when opened", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await openPanel(page, { rule, audit });
      await expectText(page, "依据来源");
      await expectText(page, "https://example.test/pdd/rules");
      await expectText(page, "审核历史");
      await expectText(page, "draft_created");
      await expectText(page, "operator-writer");
      await expectText(page, "导入官方规则候选");
      if (pageErrors.length) throw new Error(`Unexpected browser exception: ${pageErrors.join("; ")}`);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("closes the selected review detail and clears approval credentials before reopening", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await openPanel(page, { rule, audit });
      const detailCard = page.locator(".ant-card").filter({ has: page.getByText(`${rule.name} · ${rule.version}`, { exact: true }) }).last();
      await detailCard.getByRole("textbox", { name: "审核原因" }).fill("待核对原因");
      await detailCard.getByLabel("规则审批凭证").fill("short-lived-review-token");
      await detailCard.getByRole("button", { name: `关闭${rule.name}审核详情` }).click();
      await detailCard.getByText(`${rule.name} · ${rule.version}`, { exact: true }).waitFor({ state: "detached" });
      await page.waitForFunction(expected => document.activeElement?.getAttribute("aria-label") === expected, `查看${rule.name}审核详情`);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(`查看${rule.name}审核详情`);

      await page.getByRole("button", { name: `查看${rule.name}审核详情` }).click();
      const reopened = page.locator(".ant-card").filter({ has: page.getByText(`${rule.name} · ${rule.version}`, { exact: true }) }).last();
      await reopened.getByLabel("规则审批凭证").waitFor();
      expect(await reopened.getByLabel("规则审批凭证").inputValue()).toBe("");
      expect(await reopened.getByRole("textbox", { name: "审核原因" }).inputValue()).toBe("");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("offers an explicit list recovery action and never labels a failed read as an empty queue", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.addInitScript(ruleValue => {
      localStorage.setItem("ops_connection_config_v1", JSON.stringify({ apiBase: "/api", workspaceId: "ui-boundary-workspace", workbench: "platform" }));
      window.__publicRuleListCalls = 0;
      window.__publicRuleRpcMock = async (method: string) => {
        if (method !== "ops.rules.public.drafts.list") throw new Error(`Unexpected RPC method: ${method}`);
        window.__publicRuleListCalls = (window.__publicRuleListCalls ?? 0) + 1;
        if (window.__publicRuleListCalls === 1) throw new Error("模拟的规则服务暂不可用");
        return { items: [ruleValue] };
      };
    }, rule);
    try {
      await page.goto(`${baseUrl}/__public-rule-detail-test`);
      const failure = page.getByRole("alert").filter({ hasText: "公共规则审核操作失败" });
      await failure.waitFor();
      await expectText(page, "模拟的规则服务暂不可用");
      if (await page.getByText("当前筛选范围内没有待审核公共规则草稿", { exact: true }).count() !== 0) {
        throw new Error("A failed draft read was presented as an empty queue");
      }

      await failure.getByRole("button", { name: "刷新审核数据" }).click();
      await page.getByText(rule.name, { exact: true }).waitFor();
      if (await page.getByRole("alert").filter({ hasText: "公共规则审核操作失败" }).count() !== 0) {
        throw new Error("The stale list read error remained after recovery");
      }
      if (pageErrors.length) throw new Error(`Unexpected browser exception: ${pageErrors.join("; ")}`);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("keeps checksum-invalid drafts visible for review but out of batch approval", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(ruleValue => {
      localStorage.setItem("ops_connection_config_v1", JSON.stringify({ apiBase: "/api", workspaceId: "ui-boundary-workspace", workbench: "platform" }));
      window.__publicRuleRpcMock = async method => {
        if (method === "ops.rules.public.drafts.list") return { items: [{ ...ruleValue, checksum_valid: false }] };
        throw new Error(`Unexpected RPC method: ${method}`);
      };
    }, rule);
    try {
      await page.goto(`${baseUrl}/__public-rule-detail-test`);
      await page.getByText(rule.name, { exact: true }).waitFor();
      const row = page.getByRole("row", { name: new RegExp(rule.name) });
      const selection = row.getByRole("checkbox");
      expect(await selection.isDisabled()).toBe(true);
      await expectText(page, "校验失败");
      const batchButton = page.getByRole("button", { name: /一键审批选中/u });
      expect(await batchButton.isDisabled()).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("shows malformed detail errors without crashing or exposing approval", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await openPanel(page, { rule, audit: [{ id: 7, action: "draft_created", actor_id: "operator-writer", occurred_at: "2026-10-01T08:05:00.000Z" }] });
      await page.getByRole("alert").filter({ hasText: "公共规则审核操作失败" }).waitFor();
      await expectText(page, "公共规则审核记录格式无效");
      if (await page.getByRole("button", { name: "审批并激活", exact: true }).count() !== 0) {
        throw new Error("Approval control was rendered for a malformed detail response");
      }
      if (await page.getByText("拼多多发货规则 · 1.2.0", { exact: true }).count() !== 0) {
        throw new Error("Malformed detail was rendered as an opened review card");
      }
      if (pageErrors.length) throw new Error(`Unexpected browser exception: ${pageErrors.join("; ")}`);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("rejects an invalid audit timestamp instead of rendering Invalid Date", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await openPanel(page, { rule, audit: [{ ...audit[0], occurred_at: "not-a-date" }] });
      await page.getByRole("alert").filter({ hasText: "公共规则审核操作失败" }).waitFor();
      await expectText(page, "公共规则审核记录格式无效");
      if (await page.getByText("Invalid Date", { exact: true }).count() !== 0) {
        throw new Error("An invalid audit timestamp was rendered as Invalid Date");
      }
      if (pageErrors.length) throw new Error(`Unexpected browser exception: ${pageErrors.join("; ")}`);
    } finally {
      await page.close();
    }
  }, 30_000);
});

async function expectText(page: Page, text: string) {
  await page.getByText(text, { exact: false }).first().waitFor();
}

declare global {
  interface Window {
    __publicRuleListCalls?: number;
    __publicRuleRpcMock?: (method: string, params?: unknown, options?: unknown) => Promise<unknown>;
  }
}
