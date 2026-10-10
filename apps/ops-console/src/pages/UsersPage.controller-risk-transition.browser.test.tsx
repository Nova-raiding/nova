import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("UsersPage controller identity risk transition readback journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-users-risk-transition-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-users-risk-transition-${randomUUID()}`;
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

  it("confirms one account-level risk transition and reads the persisted decision back", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1200 } });
    page.setDefaultTimeout(8_000);
    const rpcCalls: Array<{ method: string; params: Record<string, unknown>; workbench?: string; workspace?: string }> = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    let riskLevel = "low";
    let riskDecision = "allow";
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
            accessStatus: "active", riskLevel, riskDecision, revision,
            membershipCount: 1, activeMembershipCount: 1,
            firstSeenAt: "2026-10-01T08:00:00.000Z", lastUpdatedAt: "2026-10-11T08:00:00.000Z",
          },
          memberships: [], audits: [], sessions: [], lifecycleEvents: riskLevel === "low" ? [] : [
            { id: "risk-event-18", eventType: "identity.risk.transition", actorId: "risk-operator", reason: "工单 OPS-418：检测到异常登录", createdAt: "2026-10-11T09:00:00.000Z" },
          ],
        };
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
      await page.getByRole("button", { name: "调整身份风险策略", exact: true }).click();
      const dialog = page.locator(".ant-modal").filter({ hasText: "调整身份风险策略" });
      await dialog.waitFor({ state: "visible" });
      const riskWrites = () => rpcCalls.filter(call => call.method === "ops.user.risk.transition");
      expect(riskWrites()).toHaveLength(0);

      const riskLevelSelect = dialog.getByRole("combobox", { name: "风险级别" });
      await riskLevelSelect.click();
      await riskLevelSelect.press("ArrowDown");
      await riskLevelSelect.press("ArrowDown");
      await riskLevelSelect.press("ArrowDown");
      await riskLevelSelect.press("Enter");
      const riskDecisionSelect = dialog.getByRole("combobox", { name: "处理方式" });
      await riskDecisionSelect.click();
      await riskDecisionSelect.press("ArrowDown");
      await riskDecisionSelect.press("ArrowDown");
      await riskDecisionSelect.press("Enter");
      await dialog.getByRole("textbox", { name: "风险策略原因" }).fill("工单 OPS-418：检测到异常登录");
      expect(riskWrites()).toHaveLength(0);
      await dialog.getByRole("button", { name: "保存风险策略", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });

      expect(riskWrites()).toHaveLength(1);
      expect(riskWrites()[0]).toMatchObject({
        params: { identity_id: "identity-risk-17", risk_level: "critical", risk_decision: "block", expected_revision: "3", reason: "工单 OPS-418：检测到异常登录", evidence_json: JSON.stringify({ source: "ops_console" }) },
        workbench: "platform", workspace: undefined,
      });
      await expectEventually(async () => rpcCalls.filter(call => call.method === "ops.user.detail").length >= 2);
      await page.getByText("严重 · 阻断并撤销会话", { exact: true }).waitFor({ state: "visible" });
      expect(riskWrites()).toHaveLength(1);
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
