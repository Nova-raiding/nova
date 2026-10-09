import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

type RpcRequest = { id: string; method: string; params: Record<string, string> };
const jsonRpc = (request: RpcRequest, result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });

describe("authorization governance model workspace target lifecycle", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-authz-model-target-"));
    const entryPath = "/__authz-model-target-entry.tsx";
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
        name: "isolated-authz-model-target",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App, Button, Space } from 'antd';
            import '/src/styles.css';
            import { AuthorizationGovernanceSection } from '/src/components/users/AuthorizationGovernanceSection.tsx';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            function Harness() {
              const [workspaceTarget, setWorkspaceTarget] = React.useState('workspace-a');
              const model = {
                authorizationTargetWorkspaceId: workspaceTarget || undefined,
                authorization: { can: capability => ['authorization.grant.read'].includes(capability), roles: ['ops_admin'], scope: { kind: 'platform' } },
                opsSession: { account_login: 'hyp@sn.com' },
              };
              return React.createElement(React.Fragment, null,
                React.createElement(Space, null,
                  React.createElement(Button, { onClick: () => setWorkspaceTarget('') }, '清空全局工作区'),
                  React.createElement(Button, { onClick: () => setWorkspaceTarget('workspace-a') }, '恢复全局工作区')),
                React.createElement(AuthorizationGovernanceSection, { model }));
            }
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(Harness)));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__authz-model-target") return next();
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
    if (!address || typeof address === "string") throw new Error("Authorization model-target listener did not bind");
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

  it("preserves manual edits but clears the bound workspace and grant rows when the model target is cleared", async () => {
    const page = await browser!.newPage();
    try {
      await page.route("**/api/mcp", async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        const result = request.method === "ops.authorization.grants.list"
          ? { subject_identity_id: request.params.subject_identity_id, workspace_id: request.params.target_workspace_id, authorization_revision: 3, grants: [{ id: `grant-${request.params.target_workspace_id}`, accessMode: "read", workspaceId: request.params.target_workspace_id, capabilities: [], ticketRef: `ticket-${request.params.target_workspace_id}`, expiresAt: new Date(Date.now() + 600_000).toISOString(), useCount: 0, maxUses: 1, revision: 1, authorizationRevision: 3 }] }
          : { schema_version: 1, policy_version: "test", generated_from: "MCP_METHOD_POLICIES", method_count: 0, role_count: 0, roles: [], assignable_roles: [], items: [] };
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(jsonRpc(request, result)) });
      });
      await page.goto(`${baseUrl}/__authz-model-target`);
      const workspace = page.getByRole("textbox", { name: "JIT 目标商家主体 ID", exact: true });
      await expect.poll(() => workspace.inputValue()).toBe("workspace-a");
      await page.getByRole("textbox", { name: "JIT 目标身份 ID", exact: true }).fill("subject-scope-test");
      await page.getByRole("button", { name: "读取有效 JIT", exact: true }).click();
      await page.getByText("ticket-workspace-a", { exact: true }).waitFor();

      await workspace.fill("workspace-b");
      await expect.poll(() => workspace.inputValue()).toBe("workspace-b");
      expect(await page.getByText("ticket-workspace-a", { exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "读取有效 JIT", exact: true }).click();
      await page.getByText("ticket-workspace-b", { exact: true }).waitFor();

      await page.getByRole("button", { name: "清空全局工作区", exact: true }).click();
      await expect.poll(() => workspace.inputValue()).toBe("");
      expect(await page.getByText("ticket-workspace-b", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "读取有效 JIT", exact: true }).isDisabled()).toBe(true);
    } finally { await page.close(); }
  }, 45_000);
});

function join(...parts: string[]) { return parts.join("/"); }
