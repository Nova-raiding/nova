import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const rule = {
  id: "public-rule-filter-race-1", platform: "pinduoduo", pack_id: "pdd-delivery", name: "拼多多发货规则",
  version: "1.2.0", status: "draft",
  source: { kind: "official", reference: "https://example.test/pdd/rules", checked_at: "2026-10-01T08:00:00.000Z", trust: "manual_pending_review" },
  checks: { dispatch_deadline_hours: 48 }, checksum: "a".repeat(64), checksum_valid: true,
  created_by: "operator-writer", created_at: "2026-10-01T08:00:00.000Z", revision: 3,
};

describe("public rule platform filter during mutation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-rule-filter-mutation-race-"));
    const entry = "/__public-rule-filter-mutation-race-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "public-rule-filter-mutation-race-rpc-mock",
        enforce: "pre",
        transform(code: string, id: string) {
          if (!id.includes("PublicRuleDraftReviewPanel.tsx")) return;
          const rpcImport = 'import { rpc } from "../../api/opsClient.js";';
          if (!code.includes(rpcImport)) throw new Error("Could not locate the public rule review RPC boundary");
          return code.replace(rpcImport, "const rpc = (method, params, options) => window.__publicRuleRpcMock(method, params, options);");
        },
        resolveId(id: string) { if (id === entry) return `\0${entry}`; },
        load(id: string) {
          if (id !== `\0${entry}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { PublicRuleDraftReviewPanel } from '/src/components/rules/PublicRuleDraftReviewPanel.tsx';
            const allowed = new Set(['rule.read', 'rule.update']);
            const authorization = { scope: { kind: 'platform' }, can: capability => allowed.has(capability) };
            createRoot(document.getElementById('root')).render(React.createElement(App, null,
              React.createElement(PublicRuleDraftReviewPanel, { authorization }),
            ));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__public-rule-filter-mutation-race") return next();
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
    if (!address || typeof address === "string") throw new Error("Rule filter mutation race test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("locks the platform filter while review mutation is pending and reloads the selected platform", async () => {
    const page = await browser!.newPage();
    await page.addInitScript(ruleValue => {
      localStorage.setItem("ops_connection_config_v1", JSON.stringify({ apiBase: "/api", workspaceId: "ui-test", workbench: "platform" }));
      window.__ruleListPlatforms = [];
      window.__ruleStatusResolve = undefined;
      window.__publicRuleRpcMock = async (method: string, params: unknown = {}) => {
        if (method === "ops.rules.public.drafts.list") {
          const platform = (params as { platform?: string }).platform;
          window.__ruleListPlatforms?.push(platform ?? "");
          return { items: !platform || platform === ruleValue.platform ? [ruleValue] : [] };
        }
        if (method === "ops.rules.public.drafts.get") return { rule: ruleValue, audit: [] };
        if (method === "rule.status") return new Promise(resolve => { window.__ruleStatusResolve = resolve; });
        throw new Error(`Unexpected RPC method: ${method}`);
      };
    }, rule);
    await page.goto(`${baseUrl}/__public-rule-filter-mutation-race`);
    try {
      const filter = page.getByRole("combobox", { name: "按平台筛选公共规则草稿" });
      await page.getByText(rule.name, { exact: true }).waitFor();
      await filter.click();
      await page.getByText("拼多多", { exact: true }).last().click();
      await page.getByText(rule.name, { exact: true }).waitFor();
      await page.getByRole("button", { name: `查看${rule.name}审核详情` }).click();
      await page.getByRole("textbox", { name: "审核原因" }).fill("依据已核对，拒绝此草稿");
      await page.getByRole("button", { name: "拒绝并归档" }).click();
      await page.waitForFunction(() => Boolean(window.__ruleStatusResolve));

      expect(await filter.isDisabled()).toBe(true);

      await page.evaluate(() => window.__ruleStatusResolve?.({ ok: true }));
      await page.waitForFunction(() => (window.__ruleListPlatforms?.length ?? 0) >= 3);
      const platforms = await page.evaluate(() => window.__ruleListPlatforms ?? []);
      expect(platforms.at(-1)).toBe("pinduoduo");
    } finally {
      await page.close();
    }
  }, 60_000);
});

declare global {
  interface Window {
    __ruleListPlatforms?: string[];
    __ruleStatusResolve?: ((value: unknown) => void) | undefined;
    __publicRuleRpcMock?: (method: string, params?: unknown, options?: unknown) => Promise<unknown>;
  }
}
