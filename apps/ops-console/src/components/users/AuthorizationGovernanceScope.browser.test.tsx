import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcRequest = { id: string; method: string; params: Record<string, string> };
const jsonRpc = (request: RpcRequest, result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });

describe("authorization governance target snapshots", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-authz-target-scope-"));
    const entryPath = "/__authz-target-scope-entry.tsx";
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
        name: "isolated-authz-target-scope",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import '/src/styles.css';
            import { AuthorizationGovernanceSection } from '/src/components/users/AuthorizationGovernanceSection.tsx';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            const model = {
              authorization: { can: capability => ['authorization.grant.read', 'authorization.grant.manage', 'authorization.role.read', 'authorization.role.manage'].includes(capability), roles: ['ops_admin'], scope: { kind: 'platform' } },
              opsSession: { account_login: 'hyp@sn.com' },
              clearAuthorizationScopedData() {}, recordJitRevocation() {}, async load() {},
            };
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(AuthorizationGovernanceSection, { model })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__authz-target-scope") return next();
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
    if (!address || typeof address === "string") throw new Error("Authorization target test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("hides old role and JIT rows immediately when their target input changes", async () => {
    const page = await browser!.newPage();
    const requests: RpcRequest[] = [];
    try {
      await page.route("**/api/mcp", async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        requests.push(request);
        const result = request.method === "ops.authorization.roles.list"
          ? { subject_identity_id: request.params.subject_identity_id, authorization_revision: 9, assignments: [{ id: "role-a", role: "ops_admin", subjectIdentityId: request.params.subject_identity_id, revision: 2, authorizationRevision: 9 }] }
          : request.method === "ops.authorization.grants.list"
            ? { subject_identity_id: request.params.subject_identity_id, workspace_id: request.params.target_workspace_id, authorization_revision: 11, grants: [{ id: "grant-a", accessMode: "read", workspaceId: request.params.target_workspace_id, capabilities: ["support.ticket.read"], ticketRef: `T-${request.params.target_workspace_id}`, expiresAt: new Date(Date.now() + 600_000).toISOString(), useCount: 0, maxUses: 1, revision: 3, authorizationRevision: 11 }] }
            : { schema_version: 1, policy_version: "test", generated_from: "MCP_METHOD_POLICIES", method_count: 0, role_count: 0, roles: [], assignable_roles: [], items: [] };
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(jsonRpc(request, result)) });
      });
      await page.goto(`${baseUrl}/__authz-target-scope`);
      await page.getByRole("textbox", { name: "JIT 目标身份 ID", exact: true }).fill("subject-a");
      await page.getByRole("textbox", { name: "JIT 目标商家主体 ID", exact: true }).fill("workspace-a");
      await page.getByRole("button", { name: "读取有效 JIT", exact: true }).click();
      await page.getByRole("button", { name: "读取当前分配", exact: true }).click();
      await page.getByText("T-workspace-a", { exact: true }).waitFor();
      await page.getByText("运营管理员", { exact: true }).waitFor();

      await page.getByRole("textbox", { name: "JIT 目标商家主体 ID", exact: true }).fill("workspace-b");
      expect(await page.getByText("T-workspace-a", { exact: true }).count()).toBe(0);

      await page.getByRole("textbox", { name: "平台角色目标身份 ID", exact: true }).fill("subject-b");
      expect(await page.getByText("运营管理员", { exact: true }).count()).toBe(0);
      expect(requests.filter(request => request.method === "ops.authorization.roles.list")).toHaveLength(1);
    } finally { await page.close(); }
  }, 45_000);

  it("discards a late response for an old workspace and keeps role/grant loading independent", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(8_000);
    page.setDefaultNavigationTimeout(8_000);
    let finishOldWorkspace: (() => void) | undefined;
    let finishRoles: (() => void) | undefined;
    let finishGrants: (() => void) | undefined;
    try {
      await page.route("**/api/mcp", async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        if (request.method === "ops.authorization.grants.list" && request.params.target_workspace_id === "workspace-a") {
          await new Promise<void>(resolve => { finishOldWorkspace = resolve; });
          const result = { subject_identity_id: request.params.subject_identity_id, workspace_id: "workspace-a", authorization_revision: 4, grants: [{ id: "late-grant-a", accessMode: "read", workspaceId: "workspace-a", capabilities: [], ticketRef: "A", expiresAt: new Date(Date.now() + 600_000).toISOString(), useCount: 0, maxUses: 1, revision: 1, authorizationRevision: 4 }] };
          return route.fulfill({ contentType: "application/json", body: JSON.stringify(jsonRpc(request, result)) });
        }
        if (request.method === "ops.authorization.grants.list") {
          await new Promise<void>(resolve => { finishGrants = resolve; });
          const result = { subject_identity_id: request.params.subject_identity_id, workspace_id: request.params.target_workspace_id, authorization_revision: 5, grants: [{ id: "current-grant-b", accessMode: "read", workspaceId: "workspace-b", capabilities: [], ticketRef: "B", expiresAt: new Date(Date.now() + 600_000).toISOString(), useCount: 0, maxUses: 1, revision: 1, authorizationRevision: 5 }] };
          return route.fulfill({ contentType: "application/json", body: JSON.stringify(jsonRpc(request, result)) });
        }
        if (request.method === "ops.authorization.roles.list") {
          await new Promise<void>(resolve => { finishRoles = resolve; });
          const result = { subject_identity_id: request.params.subject_identity_id, authorization_revision: 6, assignments: [] };
          return route.fulfill({ contentType: "application/json", body: JSON.stringify(jsonRpc(request, result)) });
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(jsonRpc(request, { schema_version: 1, policy_version: "test", generated_from: "MCP_METHOD_POLICIES", method_count: 0, role_count: 0, roles: [], assignable_roles: [], items: [] })) });
      });
      await page.goto(`${baseUrl}/__authz-target-scope`);
      await page.getByRole("textbox", { name: "JIT 目标身份 ID", exact: true }).fill("subject-a");
      await page.getByRole("textbox", { name: "JIT 目标商家主体 ID", exact: true }).fill("workspace-a");
      await page.getByRole("button", { name: "读取有效 JIT", exact: true }).click();
      await expect.poll(() => Boolean(finishOldWorkspace)).toBe(true);
      await page.getByRole("textbox", { name: "JIT 目标商家主体 ID", exact: true }).fill("workspace-b");
      await page.getByRole("button", { name: "读取有效 JIT", exact: true }).click();
      await expect.poll(() => Boolean(finishGrants)).toBe(true);
      await page.getByRole("button", { name: "读取当前分配", exact: true }).click();
      await expect.poll(() => Boolean(finishRoles)).toBe(true);

      finishRoles!();
      await expect.poll(() => page.getByRole("button", { name: "读取当前分配", exact: true }).getAttribute("aria-busy")).toBe("false");
      expect(await page.getByRole("button", { name: "读取有效 JIT", exact: true }).getAttribute("aria-busy")).toBe("true");

      finishGrants!();
      await page.getByText("B", { exact: true }).waitFor();
      finishOldWorkspace!();
      await page.waitForTimeout(50);
      expect(await page.getByText("B", { exact: true }).count()).toBe(1);
      expect(await page.getByText("A", { exact: true }).count()).toBe(0);
    } finally {
      finishOldWorkspace?.();
      finishRoles?.();
      finishGrants?.();
      await page.close();
    }
  }, 45_000);
});

function join(...parts: string[]) { return parts.join("/"); }
