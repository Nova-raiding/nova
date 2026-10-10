import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("UsersPage platform identity governance route journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-users-identity-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-users-identity-${randomUUID()}`;
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
    if (!address || typeof address === "string") throw new Error("Users controller browser listener did not bind");
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

  it("searches and filters a user, reads identity detail, confirms suspension, and reads back the new status", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const writeCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    const user = {
      id: "member-alice",
      identityId: "identity-alice",
      externalSubject: "alice@example.test",
      displayName: "Alice Example",
      role: "operator",
      status: "active",
      updatedAt: "2026-10-11T08:00:00.000Z",
      createdAt: "2026-10-01T08:00:00.000Z",
      workspaceId: "workspace-acme",
      enterpriseName: "Acme",
      accountType: "merchant",
      scope: "workspace",
      revision: 7,
      workspaceStatus: "active",
    };
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
        const call = { method, params };
        rpcCalls.push(call);
        if (!method.endsWith(".list") && method !== "ops.session" && method !== "ops.user.detail") writeCalls.push(call);

        let result: unknown = null;
        if (method === "ops.session") {
          result = {
            actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
            workbench: "platform", scope: { type: "platform" },
            capabilities: ["identity.read", "identity.update"],
          };
        } else if (method === "ops.users.list") {
          const query = String(params.query ?? "").toLowerCase();
          const status = String(params.status ?? "");
          const accountType = String(params.account_type ?? "all");
          const found = (accountType === "all" || accountType === "merchant")
            && (!query || `${user.externalSubject} ${user.displayName}`.toLowerCase().includes(query))
            && (!status || user.status === status) ? [user] : [];
          result = {
            items: found, total: found.length, identityCount: 1, workspaceCount: found.length ? 1 : 0,
            offset: Number(params.offset ?? 0), limit: Number(params.limit ?? 10), truncated: false,
          };
        } else if (method === "ops.user.detail") {
          result = {
            identity: {
              id: "identity-alice", externalSubject: "alice@example.test", displayName: "Alice Example",
              accessStatus: "active", riskLevel: "low", riskDecision: "allow", revision: 3,
              membershipCount: 1, activeMembershipCount: user.status === "active" ? 1 : 0,
              firstSeenAt: "2026-10-01T08:00:00.000Z", lastUpdatedAt: "2026-10-11T08:00:00.000Z",
            },
            memberships: [user], audits: [], sessions: [],
          };
        } else if (method === "ops.user.suspend") {
          user.status = "suspended";
          result = { success: true };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "已接入用户" }).waitFor({ state: "visible" });
      await page.getByRole("row").filter({ hasText: "alice@example.test" }).waitFor({ state: "visible" });

      await page.getByRole("textbox", { name: "按关键词筛选用户目录" }).fill("Alice");
      await page.getByRole("combobox", { name: "按激活状态筛选用户目录" }).click();
      await page.getByText("已激活", { exact: true }).last().click();
      try { await page.getByRole("button", { name: /查\s*询/u }).click({ timeout: 3_000 }); }
      catch (error) {
        const diagnostics = await page.evaluate(() => ({
          buttons: Array.from(document.querySelectorAll("button")).map(button => ({ text: button.innerText, aria: button.getAttribute("aria-label"), disabled: (button as HTMLButtonElement).disabled })),
          text: document.body.innerText.slice(0, 3000),
        }));
        throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(diagnostics)}; rpc=${JSON.stringify(rpcCalls)}`);
      }
      await page.getByRole("row").filter({ hasText: "alice@example.test" }).waitFor({ state: "visible" });
      expect(rpcCalls.filter(call => call.method === "ops.users.list").at(-1)?.params).toMatchObject({
        query: "Alice", status: "active", account_type: "merchant", limit: "10", offset: "0",
      });

      await page.getByRole("button", { name: "查看 Alice Example 的用户详情" }).click();
      await page.getByText("商户用户详情", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("identity-alice", { exact: true }).waitFor({ state: "visible" });
      expect(rpcCalls.some(call => call.method === "ops.user.detail" && call.params.identity_id === "identity-alice")).toBe(true);
      await page.keyboard.press("Escape");
      await page.getByText("商户用户详情", { exact: true }).waitFor({ state: "hidden" });

      await page.getByRole("button", { name: "停用 Alice Example 的访问" }).click();
      await page.getByRole("dialog", { name: "停用用户访问" }).waitFor({ state: "visible" });
      expect(writeCalls.filter(call => call.method === "ops.user.suspend")).toEqual([]);
      const reason = page.getByRole("textbox", { name: "操作原因（至少 4 个字符）" });
      await reason.fill("工单 OPS-921");
      await page.getByRole("button", { name: "确认停用" }).click();
      await page.getByRole("dialog", { name: "停用用户访问" }).waitFor({ state: "hidden" });
      expect(writeCalls).toEqual([{
        method: "ops.user.suspend",
        params: { workspace_id: "workspace-acme", external_subject: "alice@example.test", expected_revision: "7", reason: "工单 OPS-921" },
      }]);
      await page.getByText("没有符合条件的用户成员关系", { exact: true }).waitFor({ state: "visible" });

      await page.getByRole("button", { name: "清空筛选" }).click();
      await page.getByRole("row").filter({ hasText: "alice@example.test" }).waitFor({ state: "visible" });
      await page.getByText("已停用", { exact: true }).waitFor({ state: "visible" });
      expect(rpcCalls.filter(call => call.method === "ops.users.list").at(-1)?.params).toMatchObject({
        account_type: "merchant", limit: "10", offset: "0",
      });
      expect(writeCalls.filter(call => call.method === "ops.user.suspend")).toHaveLength(1);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
