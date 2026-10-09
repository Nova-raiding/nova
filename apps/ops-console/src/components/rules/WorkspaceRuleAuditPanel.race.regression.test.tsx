import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const rules = [
  { id: "rule-a", packId: "pack-a", name: "规则 A", version: "1", status: "active", scope: "workspace", source: { kind: "internal", reference: "internal://a", checkedAt: "2026-10-01" }, revision: 1 },
  { id: "rule-b", packId: "pack-b", name: "规则 B", version: "1", status: "active", scope: "workspace", source: { kind: "internal", reference: "internal://b", checkedAt: "2026-10-01" }, revision: 1 },
];

const auditEvent = (id: string, rulePackId: string, workspaceId = "ws-1") => ({
  id,
  workspaceId,
  rulePackId,
  ruleVersionId: `${rulePackId}-v1`,
  version: "1.0.0",
  action: "activated",
  actorId: "rules-admin",
  occurredAt: "2026-10-01T00:00:00.000Z",
  data: { source: "test" },
});

describe("workspace rule audit request ordering", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory = "";
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-workspace-rule-audit-race-"));
    const entry = "/__workspace-rule-audit-race-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "workspace-rule-audit-rpc-mock",
        enforce: "pre",
        transform(code: string, id: string) {
          if (!id.includes("WorkspaceRuleAuditPanel.tsx")) return;
          const rpcImport = 'import { rpc } from "../../api/opsClient.js";';
          if (!code.includes(rpcImport)) throw new Error("Could not locate the workspace rule audit RPC boundary");
          return code.replace(rpcImport, "const rpc = (method, params) => window.__workspaceRuleAuditRpcMock(method, params);");
        },
        resolveId(id: string) { if (id === entry) return `\0${entry}`; },
        load(id: string) {
          if (id !== `\0${entry}`) return;
          return `
            import React from 'react';
            import { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { WorkspaceRuleAuditPanel } from '/src/components/rules/WorkspaceRuleAuditPanel.tsx';
            const rules = ${JSON.stringify(rules)};
            function App() {
              const [workspaceId, setWorkspaceId] = useState('ws-a');
              return React.createElement(React.Fragment, null,
                React.createElement('button', { type: 'button', onClick: () => { window.__activeWorkspaceId = 'ws-b'; setWorkspaceId('ws-b'); } }, '切换到工作区 B'),
                React.createElement(WorkspaceRuleAuditPanel, { rules, canRead: true, workspaceId }),
              );
            }
            createRoot(document.getElementById('root')).render(React.createElement(App));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__workspace-rule-audit-race") return next();
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
    if (!address || typeof address === "string") throw new Error("Workspace rule audit race test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  }, 60_000);

  it("discards a delayed audit response after the pack filter changes", async () => {
    const page = await browser!.newPage();
    await page.addInitScript(() => {
      window.__pendingWorkspaceRuleAudits = {};
      window.__workspaceRuleAuditRpcMock = async (method: string, params: { pack_id?: string } = {}) => {
        if (method !== "ops.rules.workspace.audit") throw new Error(`Unexpected RPC method: ${method}`);
        const key = `${window.__activeWorkspaceId ?? "ws-a"}:${params.pack_id ?? "all"}`;
        return new Promise(resolve => { window.__pendingWorkspaceRuleAudits![key] = resolve; });
      };
    });
    await page.goto(`${baseUrl}/__workspace-rule-audit-race`);

    const selector = page.getByRole("combobox", { name: "按规则包筛选审计记录" });
    await selector.click();
    await page.getByText("规则 A · pack-a", { exact: true }).click();
    await page.getByRole("button", { name: "读取审计记录" }).click();
    await page.waitForFunction(() => Boolean(window.__pendingWorkspaceRuleAudits?.["ws-a:pack-a"]));

    await selector.click();
    await page.getByText("规则 B · pack-b", { exact: true }).click();
    await page.getByRole("button", { name: "读取审计记录" }).click();
    await page.waitForFunction(() => Boolean(window.__pendingWorkspaceRuleAudits?.["ws-a:pack-b"]));

    await page.evaluate((event) => window.__pendingWorkspaceRuleAudits?.["ws-a:pack-b"]?.([event]), auditEvent("event-b", "pack-b"));
    await page.locator(".ant-table-tbody").getByText("pack-b", { exact: true }).waitFor();
    await page.evaluate((event) => window.__pendingWorkspaceRuleAudits?.["ws-a:pack-a"]?.([event]), auditEvent("event-a", "pack-a"));
    await page.waitForTimeout(100);

    expect(await page.locator(".ant-table-tbody").getByText("pack-b", { exact: true }).count()).toBe(1);
    expect(await page.locator(".ant-table-tbody").getByText("pack-a", { exact: true }).count()).toBe(0);
    await page.close();
  }, 60_000);

  it("clears and discards delayed audit responses when the workspace changes", async () => {
    const page = await browser!.newPage();
    await page.addInitScript(() => {
      window.__activeWorkspaceId = "ws-a";
      window.__pendingWorkspaceRuleAudits = {};
      window.__workspaceRuleAuditRpcMock = async (method: string, params: { pack_id?: string } = {}) => {
        if (method !== "ops.rules.workspace.audit") throw new Error(`Unexpected RPC method: ${method}`);
        const key = `${window.__activeWorkspaceId ?? "ws-a"}:${params.pack_id ?? "all"}`;
        return new Promise(resolve => { window.__pendingWorkspaceRuleAudits![key] = resolve; });
      };
    });
    await page.goto(`${baseUrl}/__workspace-rule-audit-race`);
    await page.getByRole("button", { name: "读取审计记录" }).click();
    await page.waitForFunction(() => Boolean(window.__pendingWorkspaceRuleAudits?.["ws-a:all"]));

    await page.getByRole("button", { name: "切换到工作区 B" }).click();
    await page.getByText("审计范围：ws-b", { exact: true }).waitFor();
    expect(await page.locator(".ant-table-tbody tr").count()).toBe(0);

    await page.getByRole("button", { name: "读取审计记录" }).click();
    await page.waitForFunction(() => Boolean(window.__pendingWorkspaceRuleAudits?.["ws-b:all"]));
    await page.evaluate((event) => window.__pendingWorkspaceRuleAudits?.["ws-b:all"]?.([event]), auditEvent("event-b", "pack-b", "ws-b"));
    await page.locator(".ant-table-tbody").getByText("pack-b", { exact: true }).waitFor();

    await page.evaluate((event) => window.__pendingWorkspaceRuleAudits?.["ws-a:all"]?.([event]), auditEvent("event-a", "pack-a", "ws-a"));
    await page.waitForTimeout(100);
    expect(await page.getByText("审计范围：ws-b", { exact: true }).count()).toBe(1);
    expect(await page.locator(".ant-table-tbody").getByText("pack-b", { exact: true }).count()).toBe(1);
    expect(await page.locator(".ant-table-tbody").getByText("pack-a", { exact: true }).count()).toBe(0);
    await page.close();
  }, 60_000);
});

declare global {
  interface Window {
    __pendingWorkspaceRuleAudits?: Record<string, ((value: unknown) => void) | undefined>;
    __workspaceRuleAuditRpcMock?: (method: string, params?: { pack_id?: string }) => Promise<unknown>;
    __activeWorkspaceId?: string;
  }
}
