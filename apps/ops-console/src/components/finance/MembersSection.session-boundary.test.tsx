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
            let currentMemberStatus = 'active';
            const reads = [];
            const mutations = [];
            const failInitialRead = new URLSearchParams(location.search).has('fail-initial-read');
            const failPostMutationRefresh = new URLSearchParams(location.search).has('fail-post-mutation-refresh');
            const holdMemberMutation = new URLSearchParams(location.search).has('hold-member-mutation');
            window.__releaseMemberMutation = undefined;
            const client = {
              async list(workspaceId) {
                reads.push({ actor: currentActor, workspaceId });
                document.documentElement.dataset.membersReads = JSON.stringify(reads);
                if (failInitialRead && reads.length === 1) throw new Error('初始成员列表暂不可用');
                if (failPostMutationRefresh && reads.length === 2) throw new Error('变更后的列表刷新超时');
                const name = currentActor === 'actor-a' ? '成员甲' : '成员乙';
                return { items: [{ id: name, externalSubject: name, displayName: name, role: 'merchant_admin', status: currentActor === 'actor-a' ? currentMemberStatus : 'active', revision: currentMemberStatus === 'suspended' ? 2 : 1, updatedAt: '2026-09-29T00:00:00.000Z', governance: { protectedTarget: false, canChangeTarget: true, canDeactivateTarget: true } }], total: holdMemberMutation ? 21 : 1, offset: 0, limit: 20, hasMore: holdMemberMutation };
              },
              async invite(...args) { mutations.push(['invite', ...args]); document.documentElement.dataset.membersMutations = JSON.stringify(mutations); throw new Error('unexpected invite'); },
              async changeRole(...args) { mutations.push(['changeRole', ...args]); document.documentElement.dataset.membersMutations = JSON.stringify(mutations); throw new Error('unexpected role change'); },
              async deactivate(workspaceId, member, reason) {
                mutations.push(['deactivate', workspaceId, member.externalSubject, reason]);
                document.documentElement.dataset.membersMutations = JSON.stringify(mutations);
                if (holdMemberMutation) await new Promise(resolve => { window.__releaseMemberMutation = resolve; });
                currentMemberStatus = 'suspended';
                return { ...member, status: 'suspended', revision: member.revision + 1 };
              },
              async reactivate(...args) { mutations.push(['reactivate', ...args]); document.documentElement.dataset.membersMutations = JSON.stringify(mutations); throw new Error('unexpected reactivation'); },
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
            if (req.url?.split("?")[0] !== "/__members-boundary-test") return next();
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

  async function openPage(query = "") {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    await page.goto(`${baseUrl}/__members-boundary-test${query}`, { waitUntil: "domcontentloaded" });
    if (!query.includes("fail-initial-read")) await page.getByText("成员甲", { exact: true }).first().waitFor();
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

  it("gives an actionable retry for an initial read failure without asking the operator to reselect a bound workspace", async () => {
    const page: Page = await openPage("?fail-initial-read");
    try {
      const error = page.getByRole("alert", { name: "成员列表加载错误摘要" });
      await error.waitFor();
      await page.getByText("成员数据尚未取得，请刷新列表", { exact: false }).waitFor();
      expect(await page.getByText("请选择企业主体后重试", { exact: false }).count()).toBe(0);
      await error.getByRole("button", { name: "刷新成员列表" }).click();
      await page.getByText("成员甲", { exact: true }).first().waitFor();
      expect(await page.getByRole("alert").filter({ hasText: "成员列表加载失败" }).count()).toBe(0);
    } finally { await page.close(); }
  }, 45_000);

  it("closes the confirmation after a successful member change even when the follow-up list read fails", async () => {
    const page: Page = await openPage("?fail-post-mutation-refresh");
    try {
      await page.getByRole("button", { name: "停用 成员甲" }).click();
      const dialog = page.getByRole("dialog", { name: "确认停用成员" });
      await dialog.locator("textarea").fill("岗位调整后收回成员访问");
      await dialog.getByRole("button", { name: "确认停用", exact: true }).click();

      await page.getByRole("status").filter({ hasText: "已停用 成员甲" }).waitFor();
      await page.getByRole("alert").filter({ hasText: "成员已变更，但列表刷新失败" }).first().waitFor();
      await page.getByRole("dialog", { name: "确认停用成员" }).waitFor({ state: "hidden" });
      await expect.poll(() => page.locator("html").getAttribute("data-members-mutations").then(value => JSON.parse(value ?? "[]"))).toHaveLength(1);

      await page.getByRole("button", { name: "刷新成员列表" }).click();
      await page.getByText("已停用", { exact: true }).waitFor();
      expect(await page.getByRole("alert").filter({ hasText: "列表刷新失败" }).count()).toBe(0);
      expect(JSON.parse(await page.locator("html").getAttribute("data-members-mutations") ?? "[]")).toHaveLength(1);
    } finally { await page.close(); }
  }, 45_000);

  it("keeps a pending member write safe from dismissal and concurrent pagination reads", async () => {
    const page: Page = await openPage("?hold-member-mutation");
    try {
      await page.getByRole("button", { name: "停用 成员甲" }).click();
      const dialog = page.getByRole("dialog", { name: "确认停用成员" });
      await dialog.locator("textarea").fill("岗位调整后收回成员访问");
      await dialog.getByRole("button", { name: "确认停用", exact: true }).click();
      await page.waitForFunction(() => typeof window.__releaseMemberMutation === "function");

      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "visible" });
      await page.locator(".ant-pagination-next").evaluate(element => (element as HTMLElement).click());
      await expect.poll(() => page.locator("html").getAttribute("data-members-reads").then(value => JSON.parse(value ?? "[]"))).toHaveLength(1);

      await page.evaluate(() => window.__releaseMemberMutation?.());
      await page.getByRole("status").filter({ hasText: "已停用 成员甲" }).waitFor();
      await dialog.waitFor({ state: "hidden" });
      await expect.poll(() => page.locator("html").getAttribute("data-members-reads").then(value => JSON.parse(value ?? "[]"))).toHaveLength(2);
      expect(await page.getByRole("button", { name: "邀请成员" }).isDisabled()).toBe(false);
      expect(JSON.parse(await page.locator("html").getAttribute("data-members-mutations") ?? "[]")).toHaveLength(1);
    } finally { await page.close(); }
  }, 45_000);
});

declare global {
  interface Window { __releaseMemberMutation?: () => void }
}
