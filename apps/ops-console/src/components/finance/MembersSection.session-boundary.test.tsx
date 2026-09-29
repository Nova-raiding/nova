import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("members session boundary", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-members-boundary-"));
    const entryPath = "/__members-boundary-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("oidc"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("oidc"),
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "members-session-boundary-test",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { MembersSection } from '/src/components/finance/MembersSection.tsx';
            let currentActor = 'actor-a';
            const reads = [];
            const mutations = [];
            const client = {
              async list(workspaceId) {
                reads.push({ actor: currentActor, workspaceId });
                document.documentElement.dataset.membersReads = JSON.stringify(reads);
                const name = currentActor === 'actor-a' ? '成员甲' : '成员乙';
                return { items: [{ id: name, externalSubject: name, displayName: name, role: 'merchant_admin', status: 'active', revision: 1, updatedAt: '2026-09-29T00:00:00.000Z', governance: { protectedTarget: false, canChangeTarget: true, canDeactivateTarget: true } }], total: 1, offset: 0, limit: 20, hasMore: false };
              },
              async invite(...args) { mutations.push(['invite', ...args]); throw new Error('unexpected invite'); },
              async changeRole(...args) { mutations.push(['changeRole', ...args]); throw new Error('unexpected role change'); },
              async deactivate(...args) { mutations.push(['deactivate', ...args]); throw new Error('unexpected deactivation'); },
              async reactivate(...args) { mutations.push(['reactivate', ...args]); throw new Error('unexpected reactivation'); },
            };
            const capabilities = new Set(['workspace.member.read', 'workspace.member.manage', 'workspace.status.update']);
            function makeModel(actor, sessionId, workspaceId) {
              return {
                opsSession: { actor_id: actor, identity_id: actor + '-identity', session_id: sessionId, context_id: sessionId, context_version: 'v1', workspace_id: workspaceId, workbench: 'workspace', scope: { type: 'workspace', id: workspaceId }, roles: ['workspace_owner'], canonical_roles: ['workspace_owner'], workspace_granted: true, capabilities: [...capabilities], assignable_roles: ['merchant_admin', 'workspace_owner'], effective_permissions: [] },
                authorization: { managed: true, roles: ['workspace_owner'], capabilities, deniedCapabilities: new Set(), capabilityScopes: new Map(), scope: { kind: 'workspace', id: workspaceId }, policyVersion: 'v1', source: 'server', can: capability => capabilities.has(capability), canAny: values => values.some(value => capabilities.has(value)), scopeFor: () => ({ kind: 'workspace', id: workspaceId }) },
              };
            }
            function Harness() {
              const [scope, setScope] = useState({ actor: 'actor-a', sessionId: 'session-a', workspaceId: 'ws-a' });
              function switchScope(next) { currentActor = next.actor; setScope(next); }
              return React.createElement(App, null,
                React.createElement('button', { 'data-testid': 'switch-actor-same-workspace', onClick: () => switchScope({ actor: 'actor-b', sessionId: 'session-b', workspaceId: 'ws-a' }) }, '切换同工作区账号'),
                React.createElement('button', { 'data-testid': 'switch-workspace', onClick: () => switchScope({ actor: 'actor-b', sessionId: 'session-c', workspaceId: 'ws-b' }) }, '切换工作区'),
                React.createElement(MembersSection, { model: makeModel(scope.actor, scope.sessionId, scope.workspaceId), client }),
                React.createElement('output', { 'data-testid': 'reads' }, JSON.stringify(reads)),
                React.createElement('output', { 'data-testid': 'mutations' }, JSON.stringify(mutations)));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__members-boundary-test") return next();
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
    if (!address || typeof address === "string") throw new Error("Members boundary listener did not bind");
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

  async function openPage() {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    await page.goto(`${baseUrl}/__members-boundary-test`, { waitUntil: "domcontentloaded" });
    await page.getByText("成员甲", { exact: true }).first().waitFor();
    return page;
  }

  it("clears old member data and an open action when the operator changes in the same workspace", async () => {
    const page: Page = await openPage();
    try {
      await page.getByRole("button", { name: "调整 成员甲 的角色" }).click();
      const dialog = page.getByRole("dialog", { name: "调整成员角色" });
      await dialog.waitFor();
      await dialog.getByText(/成员甲/u).waitFor();
      // A host session switch can arrive while a modal is open; dispatch it
      // programmatically because the modal mask correctly blocks background
      // pointer input.
      await page.getByTestId("switch-actor-same-workspace").evaluate(element => (element as HTMLButtonElement).click());
      await page.getByText("成员乙", { exact: true }).first().waitFor();
      expect(await page.getByText("成员甲", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("dialog", { name: "调整成员角色" }).count()).toBe(0);
      await expect.poll(() => page.locator("html").getAttribute("data-members-reads").then(value => JSON.parse(value ?? "[]"))).toHaveLength(2);
      expect(JSON.parse(await page.getByTestId("mutations").textContent() ?? "[]")).toEqual([]);
    } finally { await page.close(); }
  }, 45_000);

  it("reloads the directory and removes previous tenant data when the workspace changes", async () => {
    const page: Page = await openPage();
    try {
      await page.getByTestId("switch-workspace").click();
      await page.getByText("成员乙", { exact: true }).first().waitFor();
      expect(await page.getByText("成员甲", { exact: true }).count()).toBe(0);
      await expect.poll(() => page.locator("html").getAttribute("data-members-reads").then(value => JSON.parse(value ?? "[]").map((item: { workspaceId: string }) => item.workspaceId))).toEqual(["ws-a", "ws-b"]);
    } finally { await page.close(); }
  }, 45_000);
});
