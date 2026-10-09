import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const rule = (id: string, packId: string, name: string) => ({
  id, platform: "pinduoduo", pack_id: packId, name, version: "1.0", status: "draft",
  source: { kind: "internal", reference: "manual://rules.md", checked_at: "2026-10-01T00:00:00.000Z", trust: "manual_pending_review" },
  checks: { content: name }, checksum: id.padEnd(64, "a"), checksum_valid: true,
  created_by: "writer", created_at: "2026-10-01T00:00:00.000Z", revision: 1,
});

const firstRule = rule("rule-a", "pack-a", "规则 A");
const secondRule = rule("rule-b", "pack-b", "规则 B");

describe("public rule detail request ordering", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-rule-detail-race-"));
    const entry = "/__public-rule-detail-race-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "public-rule-detail-race-rpc-mock",
        enforce: "pre",
        transform(code: string, id: string) {
          if (!id.includes("PublicRuleDraftReviewPanel.tsx")) return;
          const rpcImport = 'import { rpc } from "../../api/opsClient.js";';
          if (!code.includes(rpcImport)) throw new Error("Could not locate the public rule review RPC boundary");
          return code.replace(rpcImport, "const rpc = (method, params) => window.__publicRuleRpcMock(method, params);");
        },
        resolveId(id: string) { if (id === entry) return `\0${entry}`; },
        load(id: string) {
          if (id !== `\0${entry}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { PublicRuleDraftReviewPanel } from '/src/components/rules/PublicRuleDraftReviewPanel.tsx';
            const allowed = new Set(['rule.read', 'rule.update', 'rule.publish.approve']);
            const authorization = { scope: { kind: 'platform' }, can: capability => allowed.has(capability) };
            createRoot(document.getElementById('root')).render(React.createElement(App, null,
              React.createElement(PublicRuleDraftReviewPanel, { authorization }),
            ));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__public-rule-detail-race") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
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
    if (!address || typeof address === "string") throw new Error("Rule detail race test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("keeps the last clicked rule detail when earlier requests resolve later", async () => {
    const page = await browser!.newPage();
    await page.addInitScript(({ first, second }) => {
      localStorage.setItem("ops_connection_config_v1", JSON.stringify({ apiBase: "/api", workspaceId: "ui-test", workbench: "platform" }));
      window.__pendingRuleDetails = {};
      window.__publicRuleRpcMock = async (method: string, params: unknown = {}) => {
        if (method === "ops.rules.public.drafts.list") return { items: [first, second] };
        if (method === "ops.rules.public.drafts.get") {
          const packId = (params as { pack_id?: string }).pack_id ?? "";
          window.__pendingRuleDetails ??= {};
          return new Promise(resolve => { window.__pendingRuleDetails![packId] = resolve; });
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      };
    }, { first: firstRule, second: secondRule });
    await page.goto(`${baseUrl}/__public-rule-detail-race`);
    await page.getByText(firstRule.name, { exact: true }).waitFor();
    await page.getByText(firstRule.name, { exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__pendingRuleDetails?.["pack-a"]));
    await page.getByText(secondRule.name, { exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__pendingRuleDetails?.["pack-b"]));

    await page.evaluate(({ ruleValue }) => window.__pendingRuleDetails?.["pack-b"]?.({ rule: ruleValue, audit: [] }), { ruleValue: secondRule });
    await page.getByText("规则 B · 1.0", { exact: true }).waitFor();
    await page.evaluate(({ ruleValue }) => window.__pendingRuleDetails?.["pack-a"]?.({ rule: ruleValue, audit: [] }), { ruleValue: firstRule });
    await page.waitForTimeout(100);

    expect(await page.getByText("规则 B · 1.0", { exact: true }).count()).toBe(1);
    expect(await page.getByText("规则 A · 1.0", { exact: true }).count()).toBe(0);
    await page.close();
  }, 60_000);
});

declare global {
  interface Window {
    __pendingRuleDetails?: Record<string, ((value: unknown) => void) | undefined>;
    __publicRuleRpcMock?: (method: string, params?: unknown) => Promise<unknown>;
  }
}
