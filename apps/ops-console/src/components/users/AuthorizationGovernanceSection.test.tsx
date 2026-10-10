import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeGrantScope, describeGrantStatus, parseGrantCapabilities, validateJitExpiry } from "./AuthorizationGovernanceSection";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("AuthorizationGovernanceSection", () => {
  const source = readFileSync(new URL("./AuthorizationGovernanceSection.tsx", import.meta.url), "utf8");

  it("normalizes the comma-separated JIT capability input", () => {
    expect(parseGrantCapabilities(" support.ticket.read, ,catalog.image.retry\n")).toEqual([
      "support.ticket.read",
      "catalog.image.retry",
    ]);
  });

  it("does not manufacture a capability when the input is empty", () => {
    expect(parseGrantCapabilities(undefined)).toEqual([]);
  });

  it("keeps JIT expiry inside the mode-specific local TTL", () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    expect(validateJitExpiry("2026-09-01T00:10:00.000Z", "read", now)).toBeUndefined();
    expect(validateJitExpiry("2026-09-01T00:06:00.000Z", "write", now)).toContain("最长 5 分钟");
    expect(validateJitExpiry("2026-09-01T00:16:00.000Z", "read", now)).toContain("最长 15 分钟");
  });

  it("rejects invalid and already expired JIT expiry values", () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    expect(validateJitExpiry("not-a-date", "read", now)).toContain("有效的 ISO");
    expect(validateJitExpiry("2026-08-31T23:59:59.000Z", "read", now)).toContain("晚于当前时间");
  });

  it("describes an exact workspace scope without implying cross-tenant access", () => {
    expect(describeGrantScope(" ws_42 ")).toBe("此 JIT 仅覆盖商家主体 ws_42，不会自动扩展到其他商家主体。");
    expect(describeGrantScope(" ")).toContain("填写商家主体 ID");
  });

  it("surfaces local JIT lifecycle states for desktop operators", () => {
    const now = Date.parse("2026-09-02T10:00:00.000Z");
    expect(describeGrantStatus({ expiresAt: "2026-09-02T10:03:00.000Z", useCount: 0, maxUses: 1 }, now)).toEqual({ label: "有效", color: "green" });
    expect(describeGrantStatus({ expiresAt: "2026-09-02T10:00:30.000Z", useCount: 0, maxUses: 1 }, now)).toEqual({ label: "即将到期", color: "orange" });
    expect(describeGrantStatus({ expiresAt: "2026-09-02T09:59:59.000Z", useCount: 0, maxUses: 1 }, now)).toEqual({ label: "已过期", color: "red" });
    expect(describeGrantStatus({ expiresAt: "2026-09-02T10:05:00.000Z", useCount: 2, maxUses: 2 }, now)).toEqual({ label: "已用尽", color: "gold" });
  });

  it("transports the approver credential as a request option instead of an rpc param", () => {
    // The `approval` obligation is resolved server-side from the token grant
    // alone (`verifiedApprovalActor`), so the console must deliver it through
    // OpsRpcOptions and keep it out of the rpc body, component state and any
    // browser storage.
    expect(source).toContain("Input.Password");
    expect(source).toContain('label="审批人令牌"');
    expect(source).toContain('{ authorizationApprovalToken: String(values.approval_token ?? "").trim() }');
    expect(source).not.toContain("approval_token: values");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    // The typed name is a claim that must agree with the token grant, not the
    // thing that authorises the grant.
    expect(source).toContain('label="审批人身份"');
    expect(source).not.toContain('label="审批人"');
    expect(source).toContain("审批证据来自令牌");
    expect(source).toContain('aria-label="到期时间（读≤15m / 写≤5m）"');
    expect(source).toContain('aria-label="授权原因"');
  });

  it("keeps role and JIT recovery keyboard reachable while retaining form input", () => {
    expect(source).toContain('aria-label="分配平台角色"');
    expect(source).toContain('aria-label="签发 JIT 授权"');
    expect(source).toContain('await loadRoles();');
    expect(source).toContain('onRetry={() => grantForm.submit()}');
    expect(source).toContain('role="status"');
    expect(source).toContain("不会自动扩展到其他商家主体");
    expect(source).toContain("DangerActionModal");
    expect(source).toContain("triggerRef={revocationTriggerRef}");
    expect(source).toContain("最近一次 JIT 已撤销");
    expect(source).toContain("已检测到");
    expect(source).toContain('title: "状态"');
    expect(source).toContain("setAssignableRoles(matrix.assignable_roles)");
    expect(source).toContain('placeholder={assignableRoles.length ? "选择平台角色" : "等待服务端角色策略"}');
    expect(source).not.toContain('const platformRoles = [');
  });

  it("keeps the revoke receipt and renders governance sections in one page", () => {
    const workspaceSource = readFileSync(new URL("./UsersGovernanceWorkspace.tsx", import.meta.url), "utf8");
    const modelSource = readFileSync(new URL("../../hooks/useOpsConsoleModel.ts", import.meta.url), "utf8");
    const styleSource = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    expect(source).toContain("model.recordJitRevocation");
    expect(source).not.toContain("<Tabs");
    expect(workspaceSource).toContain('className="ops-users-secondary-navigation"');
    expect(workspaceSource).toContain("<Dropdown");
    expect(workspaceSource).toContain('label: "权限与授权"');
    expect(styleSource).not.toMatch(/\.ops-users-secondary-navigation\s*\{\s*display:\s*none/u);
    expect(workspaceSource).not.toContain("用户与权限工作台");
    expect(modelSource).toContain("jitRevocationReceipt");
  });

  it("puts the JIT target and issue form before historical grants, roles and the reference matrix", () => {
    expect(source.indexOf('aria-labelledby="jit-grants-heading"')).toBeLessThan(source.indexOf('aria-labelledby="platform-roles-heading"'));
    expect(source.indexOf('aria-labelledby="platform-roles-heading"')).toBeLessThan(source.indexOf('aria-labelledby="permission-matrix-heading"'));
    expect(source.indexOf('aria-label="签发 JIT 授权"')).toBeLessThan(source.indexOf('<Table<Grant>'));
    expect(source).toContain('className="ops-authorization-target-fields"');
  });
});

// E1 component regression: Chromium mounts the real React/Ant Design form and
// opsClient. Only its RPC boundary is simulated; no application API or database
// is started, and this does not claim OIDC/PostgreSQL acceptance.
describe("AuthorizationGovernanceSection browser form submission", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-jit-form-regression-"));
    const entryPath = "/__jit-submit-entry.tsx";
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
        name: "isolated-jit-form-regression",
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
              authorization: { can: capability => ['authorization.grant.read', 'authorization.grant.manage', ...(new URLSearchParams(location.search).has('matrix') ? ['authorization.role.read', 'authorization.role.manage'] : [])].includes(capability), roles: ['ops_admin'], scope: { kind: 'platform' } },
              opsSession: { account_login: new URLSearchParams(location.search).get('login') || 'hyp@sn.com' },
              clearAuthorizationScopedData() {}, async load() {},
            };
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement('section', { id: 'authorization-governance', className: 'ops-users-section' }, React.createElement(AuthorizationGovernanceSection, { model }))));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__jit-submit-test") return next();
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
    if (!address || typeof address === "string") throw new Error("Isolated JIT form listener did not bind");
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

  type RpcRequest = { id: string; method: string; params: Record<string, string> };
  const respond = (route: Route, request: RpcRequest, result: unknown) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
  });
  const grantList = { subject_identity_id: "subject-jit-ui", workspace_id: "ws_jit_ui_fixture", authorization_revision: 7, grants: [] };
  // The approver holds this token; the server resolves the approver from it
  // alone (`verifiedApprovalActor`), so the console may only transport it.
  const APPROVAL_TOKEN = "jit-ui-approver-token";

  async function fillGrantForm(page: Page) {
    await page.goto(`${baseUrl}/__jit-submit-test`);
    await page.getByRole("textbox", { name: "JIT 目标身份 ID", exact: true }).fill(" subject-jit-ui ");
    await page.getByRole("textbox", { name: "JIT 目标商家主体 ID", exact: true }).fill(" ws_jit_ui_fixture ");
    const loaded = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === "ops.authorization.grants.list");
    await page.getByRole("button", { name: "读取有效 JIT", exact: true }).click();
    await loaded;
    const form = page.getByRole("form", { name: "签发 JIT 授权", exact: true });
    const approvedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await form.getByLabel("能力（逗号分隔）", { exact: true }).fill(" customer.content.read, ,workspace.summary.read ");
    await form.getByLabel("工单/事故", { exact: true }).fill("JIT-COMPONENT-REGRESSION");
    await form.getByLabel("审批人身份", { exact: true }).fill("independent-approver");
    await form.getByLabel("审批人令牌", { exact: true }).fill(APPROVAL_TOKEN);
    await form.getByLabel("审批时间（ISO UTC）", { exact: true }).fill(approvedAt);
    await form.getByLabel("到期时间（读≤15m / 写≤5m）", { exact: true }).fill(expiresAt);
    await form.getByLabel("授权原因", { exact: true }).fill("核验精确工作区授权");
    return { form, approvedAt, expiresAt };
  }

  it("does not render the authorization panel for an unlisted operations administrator even when capabilities are present", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__jit-submit-test?login=unlisted-platform-admin%40example.test`);
      await page.waitForFunction(() => Boolean(document.querySelector("#root > .ant-app")));
      expect(await page.locator(".ops-authorization-card").count()).toBe(0);
      expect(await page.getByRole("form", { name: "签发 JIT 授权" }).count()).toBe(0);
    } finally { await page.close(); }
  }, 30_000);

  it("fetches the role catalog while keeping the matrix collapsed until keyboard or pointer expansion", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const requests: string[] = [];
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        requests.push(request.method);
        await respond(route, request, { schema_version: 1, policy_version: "test", generated_from: "MCP_METHOD_POLICIES", method_count: 0, role_count: 1, roles: ["platform_admin"], assignable_roles: ["platform_admin"], items: [] });
      });
      await page.goto(`${baseUrl}/__jit-submit-test?matrix=1`);
      await expect.poll(() => requests.filter(method => method === "ops.authorization.matrix.get").length).toBe(1);
      const details = page.locator(".ops-permission-matrix-details");
      expect(await details.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
      expect(await details.locator("table").count()).toBe(0);
      await details.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => details.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
      await details.locator('[aria-label="搜索插件方法或能力"]').waitFor();
      expect(requests.filter(method => method === "ops.authorization.matrix.get")).toHaveLength(1);
    } finally { await page.close(); }
  }, 30_000);

  it("submits the real JIT form with the API workspace_ids contract and the loaded revision", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const requests: RpcRequest[] = [];
    const approvalHeaders: (string | undefined)[] = [];
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        requests.push(request);
        approvalHeaders.push(route.request().headers()["x-authorization-approval-token"]);
        await respond(route, request, request.method === "ops.authorization.grants.list" ? grantList : { id: "issued-jit-ui" });
      });
      const { form, approvedAt, expiresAt } = await fillGrantForm(page);
      const targetPosition = await page.getByRole("textbox", { name: "JIT 目标身份 ID", exact: true }).boundingBox();
      const issuePosition = await page.getByRole("heading", { name: "签发 JIT 授权", exact: true }).boundingBox();
      expect(targetPosition?.y).toBeLessThan(900);
      expect(issuePosition?.y).toBeLessThan(900);
      const capabilityWidth = await form.getByLabel("能力（逗号分隔）", { exact: true }).evaluate(element => element.getBoundingClientRect().width);
      expect(capabilityWidth).toBeGreaterThan(200);
      expect(await page.locator(".ops-jit-approval-note").evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
      await form.getByRole("button", { name: "签发 JIT", exact: true }).click();
      await expect.poll(() => requests.filter(request => request.method === "ops.authorization.grant.issue").length).toBe(1);
      const issuedIndex = requests.findIndex(request => request.method === "ops.authorization.grant.issue");
      const params = requests[issuedIndex]!.params;
      // The approval obligation is satisfiable only by the server-issued token,
      // so it must reach the API as the header the approver holds...
      expect(approvalHeaders[issuedIndex]).toBe(APPROVAL_TOKEN);
      // ...and never as a body field, which would recreate the caller-supplied
      // `approved_by` claim this change removed.
      expect(params).not.toHaveProperty("approval_token");
      expect(JSON.stringify(params)).not.toContain(APPROVAL_TOKEN);
      expect(JSON.parse(params.resource_scope_json)).toEqual({ workspace_ids: ["ws_jit_ui_fixture"] });
      expect(params).toMatchObject({
        subject_identity_id: "subject-jit-ui", target_workspace_id: "ws_jit_ui_fixture",
        grant_kind: "support", access_mode: "read", expected_authorization_revision: "7", max_uses: "1",
        ticket_ref: "JIT-COMPONENT-REGRESSION", approved_by: "independent-approver",
        approved_at: approvedAt, expires_at: expiresAt, reason: "核验精确工作区授权",
      });
      expect(JSON.parse(params.capabilities_json)).toEqual(["customer.content.read", "workspace.summary.read"]);
      await expect.poll(() => requests.filter(request => request.method === "ops.authorization.grants.list").length).toBe(2);
      await expect.poll(() => form.getByLabel("授权原因", { exact: true }).inputValue()).toBe("");
      // A bearer credential must not outlive the submit it accompanied.
      await expect.poll(() => form.getByLabel("审批人令牌", { exact: true }).inputValue()).toBe("");
    } finally { await page.close(); }
  }, 45_000);

  it("retains entered values on RPC failure and does not submit again while a request is pending", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    const issued: RpcRequest[] = [];
    const issuedApprovalHeaders: (string | undefined)[] = [];
    let releaseRequest: (() => void) | undefined;
    const requestReleased = new Promise<void>(resolve => { releaseRequest = resolve; });
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        if (request.method === "ops.authorization.grants.list") return respond(route, request, grantList);
        issued.push(request);
        issuedApprovalHeaders.push(route.request().headers()["x-authorization-approval-token"]);
        if (issued.length === 1) {
          await requestReleased;
          return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "AUTHORIZATION_REVISION_CONFLICT", message: "授权修订已变化，请重新核对" } }) });
        }
        return respond(route, request, { id: "retried-jit-ui" });
      });
      const { form, expiresAt } = await fillGrantForm(page);
      // Ant Design includes the spinner's "loading" name while pending. Keep
      // the same native submit element selected across its accessible-name change.
      const submit = form.locator('button[type="submit"]');
      await submit.click();
      await expect.poll(() => issued.length).toBe(1);
      await expect.poll(() => submit.isDisabled()).toBe(true);
      expect(await submit.getAttribute("aria-busy")).toBe("true");
      await form.evaluate(element => (element as HTMLFormElement).requestSubmit());
      expect(issued).toHaveLength(1);
      releaseRequest!();
      await page.getByRole("button", { name: "重试加载运营数据", exact: true }).waitFor();
      expect(await form.getByLabel("授权原因", { exact: true }).inputValue()).toBe("核验精确工作区授权");
      expect(await form.getByLabel("到期时间（读≤15m / 写≤5m）", { exact: true }).inputValue()).toBe(expiresAt);
      // The retry control resubmits the form directly, so the token has to
      // survive a failed submit; only the success path clears it.
      expect(await form.getByLabel("审批人令牌", { exact: true }).inputValue()).toBe(APPROVAL_TOKEN);
      await page.getByRole("button", { name: "重试加载运营数据", exact: true }).click();
      await expect.poll(() => issued.length).toBe(2);
      expect(issued[1].params).toEqual(issued[0].params);
      expect(issuedApprovalHeaders).toEqual([APPROVAL_TOKEN, APPROVAL_TOKEN]);
      expect(JSON.parse(issued[1].params.resource_scope_json)).toEqual({ workspace_ids: ["ws_jit_ui_fixture"] });
    } finally { releaseRequest?.(); await page.close(); }
  }, 45_000);

  it("disables actions from a prior JIT revision while the refreshed list is pending", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1200 } });
    let grantReads = 0;
    let releaseRefresh: (() => void) | undefined;
    const refreshReleased = new Promise<void>(resolve => { releaseRefresh = resolve; });
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        if (request.method !== "ops.authorization.grants.list") return respond(route, request, { id: "ok" });
        grantReads += 1;
        if (grantReads === 1) return respond(route, request, {
          ...grantList,
          grants: [{ id: "grant-revision-ui", accessMode: "read", workspaceId: "ws_jit_ui_fixture", capabilities: ["workspace.summary.read"], ticketRef: "INC-UI", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), useCount: 0, maxUses: 1, revision: 3, authorizationRevision: 7 }],
        });
        await refreshReleased;
        return respond(route, request, { ...grantList, authorization_revision: 8, grants: [] });
      });
      await page.goto(`${baseUrl}/__jit-submit-test`);
      await page.getByRole("textbox", { name: "JIT 目标身份 ID", exact: true }).fill("subject-jit-ui");
      await page.getByRole("textbox", { name: "JIT 目标商家主体 ID", exact: true }).fill("ws_jit_ui_fixture");
      const firstRead = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === "ops.authorization.grants.list");
      await page.getByRole("button", { name: "读取有效 JIT", exact: true }).click();
      await firstRead;
      const revoke = page.getByRole("button", { name: "立即撤销", exact: true });
      expect(await revoke.count()).toBe(1);
      expect(await revoke.isDisabled()).toBe(false);

      const secondRead = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === "ops.authorization.grants.list").catch(() => undefined);
      await page.getByRole("button", { name: "读取有效 JIT", exact: true }).click();
      await expect.poll(() => grantReads).toBe(2);
      await expect.poll(() => revoke.count()).toBe(0);
      expect(await page.getByRole("button", { name: "签发 JIT", exact: true }).isDisabled()).toBe(true);
      releaseRefresh!();
      await secondRead;
    } finally { releaseRefresh?.(); await page.close(); }
  }, 45_000);

  it("requires the latest role revision and submits that exact revision with the server role catalog", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1800 } });
    const requests: RpcRequest[] = [];
    let assigned = false;
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        requests.push(request);
        if (request.method === "ops.authorization.matrix.get") {
          return respond(route, request, { schema_version: 1, policy_version: "test", generated_from: "MCP_METHOD_POLICIES", method_count: 0, role_count: 1, roles: ["model_admin"], assignable_roles: ["model_admin"], items: [] });
        }
        if (request.method === "ops.authorization.roles.list") {
          return respond(route, request, { subject_identity_id: "subject-role-ui", authorization_revision: 23, assignments: assigned ? [{ id: "assignment-role-ui", role: "model_admin", subject_identity_id: "subject-role-ui", revision: 1, authorization_revision: 24 }] : [] });
        }
        if (request.method === "ops.authorization.role.assign") {
          assigned = true;
          return respond(route, request, { id: "assignment-role-ui", role: "model_admin" });
        }
        throw new Error(`Unexpected authorization RPC: ${request.method}`);
      });
      await page.goto(`${baseUrl}/__jit-submit-test?matrix=1`);
      const form = page.getByRole("form", { name: "分配平台角色", exact: true });
      const submit = form.getByRole("button", { name: "分配角色", exact: true });
      await page.getByRole("textbox", { name: "平台角色目标身份 ID", exact: true }).fill(" subject-role-ui ");
      expect(await submit.isDisabled()).toBe(true);
      await expect.poll(() => requests.filter(request => request.method === "ops.authorization.roles.list").length).toBe(0);
      const rolesLoaded = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === "ops.authorization.roles.list");
      await page.getByRole("button", { name: "读取当前分配", exact: true }).click();
      await rolesLoaded;
      expect(requests.find(request => request.method === "ops.authorization.roles.list")?.params).toMatchObject({ subject_identity_id: "subject-role-ui" });
      expect(requests.filter(request => request.method === "ops.authorization.role.assign")).toHaveLength(0);
      await form.locator(".ant-select").click();
      await page.locator(".ant-select-item-option-content").filter({ hasText: "模型管理员" }).click();
      await form.locator('input[placeholder="说明工单或业务原因"]').fill("经工单核对授权");
      await submit.click();
      await expect.poll(() => requests.filter(request => request.method === "ops.authorization.role.assign").length).toBe(1);
      const assignment = requests.find(request => request.method === "ops.authorization.role.assign")!;
      expect(assignment.params).toMatchObject({
        subject_identity_id: "subject-role-ui",
        role: "model_admin",
        expected_authorization_revision: "23",
        reason: "经工单核对授权",
      });
    } finally { await page.close(); }
  }, 45_000);

  it("fails closed after a role assignment error when its revision refresh fails", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1800 } });
    const requests: RpcRequest[] = [];
    let failRoleReads = false;
    const stage = async <T,>(name: string, operation: () => Promise<T>, timeoutMs = 8_000): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`stage timeout: ${name} (${timeoutMs}ms)`)), timeoutMs);
          }),
        ]);
      } catch (error) {
        throw new Error(`stage failed: ${name}`, { cause: error });
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        requests.push(request);
        if (request.method === "ops.authorization.matrix.get") {
          return respond(route, request, { schema_version: 1, policy_version: "test", generated_from: "MCP_METHOD_POLICIES", method_count: 0, role_count: 1, roles: ["model_admin"], assignable_roles: ["model_admin"], items: [] });
        }
        if (request.method === "ops.authorization.roles.list") {
          if (failRoleReads) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "TEMPORARY_FAILURE", message: "角色读取失败" } }) });
          return respond(route, request, { subject_identity_id: "subject-role-ui", authorization_revision: 23, assignments: [] });
        }
        if (request.method === "ops.authorization.role.assign") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "TEMPORARY_FAILURE", message: "角色分配失败" } }) });
        throw new Error(`Unexpected authorization RPC: ${request.method}`);
      });
      await stage("goto", () => page.goto(`${baseUrl}/__jit-submit-test?matrix=1`, { timeout: 30_000 }), 30_000);
      const form = page.getByRole("form", { name: "分配平台角色", exact: true });
      const submit = form.getByRole("button", { name: "分配角色", exact: true });
      await stage("initial roles read", async () => {
        const initialRead = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === "ops.authorization.roles.list", { timeout: 8_000 });
        await page.getByRole("textbox", { name: "平台角色目标身份 ID", exact: true }).fill("subject-role-ui", { timeout: 8_000 });
        await page.getByRole("button", { name: "读取当前分配", exact: true }).click({ timeout: 8_000 });
        await initialRead;
        await expect.poll(() => submit.isEnabled(), { timeout: 8_000 }).toBe(true);
      });

      await stage("role selection", async () => {
        await form.locator(".ant-select").click({ timeout: 8_000 });
        await page.locator(".ant-select-item-option-content").filter({ hasText: "模型管理员" }).click({ timeout: 8_000 });
        await form.locator('input[placeholder="说明工单或业务原因"]').fill("经工单核对授权", { timeout: 8_000 });
      });
      await stage("assign response", async () => {
        const assignmentFailure = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === "ops.authorization.role.assign", { timeout: 8_000 });
        await submit.click({ timeout: 8_000 });
        const assignmentResponse = await assignmentFailure;
        const assignmentBody = await assignmentResponse.json() as { error?: { code?: string; message?: string } };
        expect(assignmentBody.error?.code).toBe("TEMPORARY_FAILURE");
        expect(assignmentBody.error?.message).toBe("角色分配失败");
        expect(requests.filter(request => request.method === "ops.authorization.role.assign")).toHaveLength(1);
      });
      failRoleReads = true;
      const retry = page.getByRole("button", { name: "重试加载运营数据", exact: true }).last();
      await stage("retry button", async () => {
        await retry.waitFor({ state: "visible", timeout: 8_000 });
        const failedRead = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === "ops.authorization.roles.list", { timeout: 8_000 });
        await retry.click({ timeout: 8_000 });
        await failedRead;
      });
      await stage("button disabled", () => expect.poll(() => submit.isDisabled(), { timeout: 5_000 }).toBe(true), 5_000);
      await stage("error retained", async () => {
        expect(await page.locator(".ops-page-error").count()).toBeGreaterThan(0);
        expect(requests.find(request => request.method === "ops.authorization.role.assign")?.params.expected_authorization_revision).toBe("23");
      }, 5_000);
      await stage("form.requestSubmit", async () => {
        await form.evaluate(element => (element as HTMLFormElement).requestSubmit());
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(await submit.isDisabled()).toBe(true);
        expect(await page.locator(".ops-page-error").count()).toBeGreaterThan(0);
      }, 5_000);
      await stage("assignment count", async () => {
        expect(requests.filter(request => request.method === "ops.authorization.role.assign")).toHaveLength(1);
      }, 5_000);
    } finally {
      await stage("page.close", () => page.close());
    }
  }, 60_000);
});
