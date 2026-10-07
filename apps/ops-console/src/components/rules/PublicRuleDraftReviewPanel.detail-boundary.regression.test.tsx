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
 * the /mcp HTTP boundary is intercepted with deterministic responses. This
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
    await page.addInitScript(() => {
      localStorage.setItem("ops_connection_config_v1", JSON.stringify({ apiBase: "/api", workspaceId: "ui-boundary-workspace", workbench: "platform" }));
    });
    await page.route("**/api/mcp", async route => {
      const request = route.request().postDataJSON() as { id: string; method: string };
      const result = request.method === "ops.rules.public.drafts.list"
        ? { items: [rule] }
        : request.method === "ops.rules.public.drafts.get"
          ? detailResponse
          : undefined;
      if (result === undefined) throw new Error(`Unexpected RPC method: ${request.method}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      });
    });
    await page.goto(`${baseUrl}/__public-rule-detail-test`);
    await page.waitForTimeout(1_000);
    const initialText = await page.locator("body").innerText();
    if (!initialText.includes(rule.name)) throw new Error(`Draft list did not render. Browser text: ${initialText}`);
    await page.getByText(rule.name, { exact: true }).waitFor();
    await page.getByText(rule.name, { exact: true }).click();
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
});

async function expectText(page: Page, text: string) {
  await page.getByText(text, { exact: false }).first().waitFor();
}
