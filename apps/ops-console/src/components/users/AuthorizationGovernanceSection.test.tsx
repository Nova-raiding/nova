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

  it("keeps role and JIT recovery keyboard reachable while retaining form input", () => {
    expect(source).toContain('aria-label="分配平台角色"');
    expect(source).toContain('aria-label="签发 JIT 授权"');
    expect(source).toContain('onRetry={() => roleForm.submit()}');
    expect(source).toContain('onRetry={() => grantForm.submit()}');
    expect(source).toContain('role="status"');
    expect(source).toContain("不会自动扩展到其他商家主体");
    expect(source).toContain("DangerActionModal");
    expect(source).toContain("triggerRef={revocationTriggerRef}");
    expect(source).toContain("最近一次 JIT 已撤销");
    expect(source).toContain("已检测到");
    expect(source).toContain('title: "状态"');
  });

  it("keeps the revoke receipt and renders governance sections in one page", () => {
    const workspaceSource = readFileSync(new URL("./UsersGovernanceWorkspace.tsx", import.meta.url), "utf8");
    const modelSource = readFileSync(new URL("../../hooks/useOpsConsoleModel.ts", import.meta.url), "utf8");
    expect(source).toContain("model.recordJitRevocation");
    expect(source).not.toContain("<Tabs");
    expect(workspaceSource).not.toContain("<Tabs");
    expect(workspaceSource).toContain('className="ops-users-sections"');
    expect(workspaceSource).not.toContain("用户与权限工作台");
    expect(modelSource).toContain("jitRevocationReceipt");
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
            import { AuthorizationGovernanceSection } from '/src/components/users/AuthorizationGovernanceSection.tsx';
            sessionStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            const model = {
              authorization: { can: capability => ['authorization.grant.read', 'authorization.grant.manage'].includes(capability) },
              clearAuthorizationScopedData() {}, async load() {},
            };
            createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(AuthorizationGovernanceSection, { model })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__jit-submit-test") return next();
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
    await form.getByLabel("审批人", { exact: true }).fill("independent-approver");
    await form.getByLabel("审批时间（ISO UTC）", { exact: true }).fill(approvedAt);
    await form.getByLabel("到期时间（读≤15m / 写≤5m）", { exact: true }).fill(expiresAt);
    await form.getByLabel("授权原因", { exact: true }).fill("核验精确工作区授权");
    return { form, approvedAt, expiresAt };
  }

  it("submits the real JIT form with the API workspace_ids contract and the loaded revision", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const requests: RpcRequest[] = [];
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        requests.push(request);
        await respond(route, request, request.method === "ops.authorization.grants.list" ? grantList : { id: "issued-jit-ui" });
      });
      const { form, approvedAt, expiresAt } = await fillGrantForm(page);
      await form.getByRole("button", { name: "签发 JIT", exact: true }).click();
      await expect.poll(() => requests.filter(request => request.method === "ops.authorization.grant.issue").length).toBe(1);
      const params = requests.find(request => request.method === "ops.authorization.grant.issue")!.params;
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
    } finally { await page.close(); }
  }, 45_000);

  it("retains entered values on RPC failure and does not submit again while a request is pending", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    const issued: RpcRequest[] = [];
    let releaseRequest: (() => void) | undefined;
    const requestReleased = new Promise<void>(resolve => { releaseRequest = resolve; });
    try {
      await page.route(`${baseUrl}/api/mcp`, async route => {
        const request = route.request().postDataJSON() as RpcRequest;
        if (request.method === "ops.authorization.grants.list") return respond(route, request, grantList);
        issued.push(request);
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
      await page.getByRole("button", { name: "重试加载运营数据", exact: true }).click();
      await expect.poll(() => issued.length).toBe(2);
      expect(issued[1].params).toEqual(issued[0].params);
      expect(JSON.parse(issued[1].params.resource_scope_json)).toEqual({ workspace_ids: ["ws_jit_ui_fixture"] });
    } finally { releaseRequest?.(); await page.close(); }
  }, 45_000);
});
