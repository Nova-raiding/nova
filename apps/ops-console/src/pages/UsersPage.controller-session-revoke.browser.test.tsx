import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("UsersPage controller identity session revoke readback journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-users-session-revoke-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-users-session-revoke-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/users?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'fixture-token', actorId: 'fixture-operator'}));
      createRoot(document.getElementById('root')).render(React.createElement(OpsConsoleController));
    `, { flag: "wx" });
    vite = await createServer({
      configFile: false,
      root: appRoot,
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"),
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("local"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("local"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Users risk transition controller browser listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally {
        try { await Promise.all(harnessFiles.map(file => rm(file, { force: true }))); }
        finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
      }
    }
  }, 60_000);

  it("confirms revocation of one active identity session and reads its status back", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1200 } });
    page.setDefaultTimeout(20_000);
    const rpcCalls: Array<{ method: string; params: Record<string, unknown>; workbench?: string; workspace?: string }> = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    let sessionStatus = "active";
    let sessionRevision = 5;
    let failNextDetailReadback = false;
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin) return route.fallback();
        unexpectedRequests.push(url.origin);
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname === "/api/mcp", async route => {
        const request = route.request();
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { rpc = request.postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        rpcCalls.push({ method, params, workbench: request.headers()["x-ops-workbench"], workspace: request.headers()["x-workspace-id"] });
        let result: unknown = null;
        if (method === "ops.session") result = {
          actor_id: "session-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" },
          capabilities: ["identity.read", "identity.update"],
        };
        else if (method === "ops.users.list") result = {
          items: [{ id: "member-session", identityId: "identity-session-22", externalSubject: "session@example.test", displayName: "Session Example", role: "operator", status: "active", updatedAt: "2026-10-11T08:00:00.000Z", createdAt: "2026-10-01T08:00:00.000Z", workspaceId: "workspace-session", enterpriseName: "Session Co", accountType: "merchant", scope: "workspace", revision: 7, workspaceStatus: "active" }],
          total: 1, identityCount: 1, workspaceCount: 1, offset: Number(params.offset ?? 0), limit: Number(params.limit ?? 10), truncated: false,
        };
        else if (method === "ops.user.detail" && failNextDetailReadback) {
          failNextDetailReadback = false;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32000, message: "详情回读暂时失败" },
          }) });
          return;
        }
        else if (method === "ops.user.detail") result = {
          identity: {
            id: "identity-session-22", externalSubject: "session@example.test", displayName: "Session Example",
            accessStatus: "active", riskLevel: "low", riskDecision: "allow", revision: 8,
            membershipCount: 1, activeMembershipCount: 1,
            firstSeenAt: "2026-10-01T08:00:00.000Z", lastUpdatedAt: "2026-10-11T08:00:00.000Z",
          },
          memberships: [], audits: [], lifecycleEvents: [],
          sessions: [{ id: "session-oidc-22", sessionKind: "oidc", status: sessionStatus, mfaVerified: true, issuedAt: "2026-10-11T08:00:00.000Z", expiresAt: "2026-10-18T08:00:00.000Z", lastSeenAt: "2026-10-11T09:00:00.000Z", revision: sessionRevision }],
        };
        else if (method === "ops.user.session.revoke") {
          sessionStatus = "revoked";
          sessionRevision += 1;
          failNextDetailReadback = true;
          result = { success: true, revision: sessionRevision };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "已接入用户" }).waitFor({ state: "visible" });
      await page.getByRole("row").filter({ hasText: "session@example.test" }).getByRole("button", { name: "查看 Session Example 的用户详情" }).click();
      await page.getByText("identity-session-22", { exact: true }).waitFor({ state: "visible" });
      const sessionRow = page.getByRole("row").filter({ hasText: "session-oidc-22" });
      await sessionRow.getByText("活动", { exact: true }).waitFor({ state: "visible" });
      await sessionRow.getByRole("button", { name: /撤销会话/u }).click();
      const confirm = page.locator(".ant-modal").filter({ hasText: "撤销认证会话" });
      await confirm.waitFor({ state: "visible" });
      const revokeCalls = () => rpcCalls.filter(call => call.method === "ops.user.session.revoke");
      expect(revokeCalls()).toHaveLength(0);
      await confirm.getByRole("textbox", { name: "撤销原因" }).fill("工单 OPS-422：凭据疑似泄露");
      expect(revokeCalls()).toHaveLength(0);
      await confirm.getByRole("button", { name: "确认撤销会话", exact: true }).click();
      await confirm.waitFor({ state: "hidden" });

      expect(revokeCalls()).toHaveLength(1);
      expect(revokeCalls()[0]).toMatchObject({
        params: { identity_id: "identity-session-22", session_id: "session-oidc-22", expected_revision: "5", reason: "工单 OPS-422：凭据疑似泄露" },
        workbench: "platform", workspace: undefined,
      });
      expect(typeof revokeCalls()[0].params.idempotency_key).toBe("string");
      expect(String(revokeCalls()[0].params.idempotency_key).length).toBeGreaterThan(0);
      await expectEventually(async () => rpcCalls.filter(call => call.method === "ops.user.detail").length >= 2);
      await page.getByRole("button", { name: "重试读取用户详情", exact: true }).waitFor({ state: "visible" });
      expect(revokeCalls()).toHaveLength(1);
      await page.getByRole("button", { name: "重试读取用户详情", exact: true }).click();
      await expectEventually(async () => rpcCalls.filter(call => call.method === "ops.user.detail").length >= 3);
      await sessionRow.getByText("已撤销", { exact: true }).waitFor({ state: "visible" });
      expect(await sessionRow.getByRole("button", { name: /撤销会话/u }).count()).toBe(0);
      expect(revokeCalls()).toHaveLength(1);
      const detailReads = rpcCalls.filter(call => call.method === "ops.user.detail");
      expect(detailReads).toHaveLength(3);
      expect(detailReads.every(call => call.params.identity_id === "identity-session-22" && call.workbench === "platform" && call.workspace === undefined)).toBe(true);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);
});

async function expectEventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(await predicate()).toBe(true);
}
