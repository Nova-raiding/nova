import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("UsersPage controller global identity access journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-users-global-access-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-users-global-access-${randomUUID()}`;
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
    if (!address || typeof address === "string") throw new Error("Users global access controller browser listener did not bind");
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

  it("opens global identity suspension, confirms once, and reads access status back", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1200 } });
    page.setDefaultTimeout(8_000);
    const rpcCalls: Array<{ method: string; params: Record<string, unknown>; workbench?: string; workspace?: string }> = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    let riskLevel = "low";
    let riskDecision = "allow";
    let accessStatus = "active";
    let revision = 3;
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
          actor_id: "risk-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
          workbench: "platform", scope: { type: "platform" },
          capabilities: ["identity.read", "identity.update"],
        };
        else if (method === "ops.users.list") result = {
          items: [{ id: "member-risk", identityId: "identity-risk-17", externalSubject: "risk@example.test", displayName: "Risk Example", role: "operator", status: "active", updatedAt: "2026-10-11T08:00:00.000Z", createdAt: "2026-10-01T08:00:00.000Z", workspaceId: "workspace-risk", enterpriseName: "Risk Co", accountType: "merchant", scope: "workspace", revision: 7, workspaceStatus: "active" }],
          total: 1, identityCount: 1, workspaceCount: 1, offset: Number(params.offset ?? 0), limit: Number(params.limit ?? 10), truncated: false,
        };
        else if (method === "ops.user.detail") result = {
          identity: {
            id: "identity-risk-17", externalSubject: "risk@example.test", displayName: "Risk Example",
            accessStatus, riskLevel, riskDecision, revision,
            membershipCount: 1, activeMembershipCount: 1,
            firstSeenAt: "2026-10-01T08:00:00.000Z", lastUpdatedAt: "2026-10-11T08:00:00.000Z",
          },
          memberships: [], audits: [], sessions: [], lifecycleEvents: accessStatus === "suspended" ? [
            { id: "identity-suspended-18", eventType: "identity.suspended", actorId: "risk-operator", reason: "工单 OPS-419：持久身份访问需全局停用", createdAt: "2026-10-11T09:10:00.000Z" },
          ] : [],
        };
        else if (method === "ops.user.suspend" || method === "ops.user.activate") {
          accessStatus = method === "ops.user.suspend" ? "suspended" : "active";
          revision += 1;
          result = { success: true, revision };
        }
        else if (method === "ops.user.risk.transition") {
          riskLevel = String(params.risk_level);
          riskDecision = String(params.risk_decision);
          revision += 1;
          result = { success: true, revision };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "已接入用户" }).waitFor({ state: "visible" });
      await page.getByRole("row").filter({ hasText: "risk@example.test" }).getByRole("button", { name: "查看 Risk Example 的用户详情" }).click();
      await page.getByText("identity-risk-17", { exact: true }).waitFor({ state: "visible" });
      const suspendAction = page.getByRole("button", { name: "全局停用身份", exact: true });
      await suspendAction.waitFor({ state: "visible" });
      await suspendAction.click();
      const dialog = page.locator(".ant-modal").filter({ hasText: "全局停用平台身份" });
      await dialog.waitFor({ state: "visible" });
      const accessWrites = () => rpcCalls.filter(call => call.method === "ops.user.suspend" || call.method === "ops.user.activate");
      expect(accessWrites()).toHaveLength(0);
      const confirm = dialog.getByRole("button", { name: "确认执行", exact: true });
      expect(await confirm.isDisabled()).toBe(true);
      await dialog.getByLabel("操作原因（至少 4 个字符）").fill("工单 OPS-419：持久身份访问需全局停用");
      expect(accessWrites()).toHaveLength(0);
      await confirm.click();
      await dialog.waitFor({ state: "hidden" });
      expect(accessWrites()).toHaveLength(1);
      expect(accessWrites()[0]).toMatchObject({
        method: "ops.user.suspend",
        params: { scope: "identity", identity_id: "identity-risk-17", expected_revision: "3", reason: "工单 OPS-419：持久身份访问需全局停用" },
        workbench: "platform", workspace: undefined,
      });
      expect(accessWrites()[0]?.params.idempotency_key).toMatch(/^[0-9a-f-]{36}$/u);
      await expectEventually(async () => rpcCalls.filter(call => call.method === "ops.user.detail").length >= 2);
      await page.getByRole("button", { name: "恢复平台身份", exact: true }).waitFor({ state: "visible" });
      expect(accessWrites()).toHaveLength(1);
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
