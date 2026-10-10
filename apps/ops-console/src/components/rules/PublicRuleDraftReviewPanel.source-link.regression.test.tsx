import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const rule = {
  id: "public-rule-source-1", platform: "pinduoduo", pack_id: "pdd-delivery", name: "拼多多发货规则",
  version: "1.2.0", status: "draft",
  source: { kind: "official", reference: "https://example.test/pdd/rules", checked_at: "2026-10-01T08:00:00.000Z", trust: "manual_pending_review" },
  checks: { dispatch_deadline_hours: 48 }, checksum: "a".repeat(64), checksum_valid: true,
  created_by: "operator-writer", created_at: "2026-10-01T08:00:00.000Z", revision: 3,
};
const detail = { rule, audit: [] };

describe("public rule review source link", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-rule-source-link-"));
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "public-rule-source-link-rpc-mock",
        enforce: "pre",
        transform(code: string, id: string) {
          if (id.includes("PublicRuleDraftReviewPanel.tsx")) {
            const rpcImport = 'import { rpc } from "../../api/opsClient.js";';
            if (!code.includes(rpcImport)) throw new Error("Could not locate the review panel RPC boundary");
            return code.replace(rpcImport, "const rpc = (method) => window.__ruleRpcMock(method);");
          }
        },
        resolveId(id: string) { if (id === "/__source-link-entry.tsx") return "\0/__source-link-entry.tsx"; },
        load(id) {
          if (id !== "\0/__source-link-entry.tsx") return;
          return `
            import React from 'react'; import { createRoot } from 'react-dom/client'; import { App } from 'antd';
            import { PublicRuleDraftReviewPanel } from '/src/components/rules/PublicRuleDraftReviewPanel.tsx';
            const authorization = { scope: { kind: 'platform' }, can: capability => ['rule.read', 'rule.update'].includes(capability) };
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(PublicRuleDraftReviewPanel, { authorization })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__source-link-test") return next();
            void server.transformIndexHtml(req.url, `<!doctype html><html><body><div id="root"></div><script type="module" src="/__source-link-entry.tsx"></script></body></html>`)
              .then(html => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Rule source link test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  async function openDetail(reference: string) {
    const page = await browser!.newPage();
    const diagnostics: string[] = [];
    page.on("pageerror", error => diagnostics.push(error.message));
    page.on("console", entry => { if (entry.type() === "error") diagnostics.push(entry.text()); });
    await page.addInitScript(({ ruleValue, detailValue, referenceValue }) => {
      localStorage.setItem("ops_connection_config_v1", JSON.stringify({ apiBase: "/api", workspaceId: "review", workbench: "platform" }));
      const row = { ...ruleValue, source: { ...ruleValue.source, reference: referenceValue } };
      (window as Window & { __ruleRpcMock?: (method: string) => Promise<unknown> }).__ruleRpcMock = async (method: string) => method === "ops.rules.public.drafts.list" ? { items: [row] } : method === "ops.rules.public.drafts.get" ? { ...detailValue, rule: row } : null;
    }, { ruleValue: rule, detailValue: detail, referenceValue: reference });
    try {
      await page.goto(`${baseUrl}/__source-link-test`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.getByText(rule.name, { exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: `查看${rule.name}审核详情` }).click({ timeout: 20_000 });
      await page.getByText("依据来源", { exact: true }).waitFor({ timeout: 20_000 });
    } catch (cause) {
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\nBrowser errors: ${diagnostics.join(" | ")}\nBody: ${(await page.locator("body").innerText().catch(() => "<unavailable>")).slice(0, 2000)}`);
    }
    return page;
  }

  it("opens an HTTPS source in a separate tab with a visible host and safe link attributes", async () => {
    const page = await openDetail("https://example.test/pdd/rules");
    try {
      const link = page.getByRole("link", { name: "打开来源（example.test）" });
      await link.waitFor();
      expect(await link.getAttribute("href")).toBe("https://example.test/pdd/rules");
      expect(await link.getAttribute("target")).toBe("_blank");
      expect(await link.getAttribute("rel")).toContain("noreferrer");
    } finally { await page.close(); }
  }, 30_000);

  it("keeps non-HTTPS references copyable without turning them into links", async () => {
    const page = await openDetail("javascript:alert(1)");
    try {
      await page.getByText("javascript:alert(1)", { exact: true }).waitFor();
      expect(await page.getByRole("link", { name: /打开来源/ }).count()).toBe(0);
    } finally { await page.close(); }
  }, 30_000);
});
