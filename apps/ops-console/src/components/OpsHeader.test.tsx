import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { OpsHeader } from "./OpsHeader.js";

describe("OpsHeader account authentication UX", () => {
  it("shows account/password login for an unauthenticated operator", () => {
    const markup = renderToStaticMarkup(
      <OpsHeader managedSession={false} sessionLoaded={false} onRefresh={() => undefined} />,
    );
    expect(markup).toContain("平台运营账号登录");
    expect(markup).toContain("打开账号信息");
    expect(markup).not.toContain("当前状态");
  });

  it("keeps only the account/password path when the legacy managed flag is present", () => {
    const markup = renderToStaticMarkup(
      <OpsHeader managedSession sessionLoaded={false} onRefresh={() => undefined} />,
    );
    expect(markup).toContain("平台运营账号登录");
    expect(markup).toContain("打开账号信息");
    expect(markup).not.toContain("组织登录");
  });

  it("documents server-side session and password handling", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("./OpsHeader.tsx", import.meta.url), "utf8"),
    );
    expect(source).toContain("HttpOnly 会话");
    expect(source).toContain("密码不会保存到浏览器");
  });

  it("renders authenticated logout state and account identity wiring", async () => {
    const markup = renderToStaticMarkup(
      <OpsHeader
        managedSession={false}
        sessionLoaded
        session={{
          actor_id: "5902c96f-508f-420c-a82a-ef4c69de59db",
          account_login: "ops@example.com",
          workspace_id: "",
          roles: ["platform_ops"],
          workbench: "platform",
          workspace_granted: false,
          scope: { type: "platform" },
        }}
        onRefresh={() => undefined}
      />,
    );
    expect(markup).toContain("ops@example.com");
    expect(markup).not.toContain("5902c96f-508f-420c-a82a-ef4c69de59db");
    expect(markup).toContain("打开账号信息");
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("./OpsHeader.tsx", import.meta.url), "utf8"),
    );
    expect(source).toContain("accountLabel(session)");
    expect(source).toContain("当前账号");
    expect(source).toContain("退出登录");
  });

  it.each([undefined, null, "", "   "])("never uses an internal subject as a missing account label (%s)", (login) => {
    const markup = renderToStaticMarkup(
      <OpsHeader managedSession sessionLoaded onRefresh={() => undefined}
        session={{ actor_id: "oidc-private-subject", account_login: login, workspace_id: "ws", roles: ["merchant_admin"], workspace_granted: true, session_id: "sid" }} />,
    );
    expect(markup).toContain("账号名称未提供");
    expect(markup).not.toContain("oidc-private-subject");
  });

  it("consumes the JIT callbacks it is given instead of accepting them unused", () => {
    // The controlled-session bar only renders its exit control when the header
    // actually forwards onJitExit, so its presence is the proof that the
    // expiry/exit cleanup chain is reachable from the shell.
    const liveGrant = {
      id: "grant_1",
      access_mode: "read" as const,
      workspace_id: "ws_1",
      resource_scope: { type: "workspace", ids: ["ws_1"] },
      expires_at: "2999-01-01T00:00:00.000Z",
    };
    const base = {
      managedSession: false,
      sessionLoaded: true,
      onRefresh: () => undefined,
      session: {
        actor_id: "5902c96f-508f-420c-a82a-ef4c69de59db",
        account_login: "ops@example.com",
        workspace_id: "ws_1",
        roles: ["platform_ops"],
        workbench: "platform" as const,
        workspace_granted: true,
        scope: { type: "platform" as const },
      },
    };
    const withoutGrant = renderToStaticMarkup(<OpsHeader {...base} onJitExpired={() => undefined} onJitExit={() => undefined} />);
    expect(withoutGrant).not.toContain("受控会话");

    const withGrant = renderToStaticMarkup(
      <OpsHeader
        {...base}
        session={{ ...base.session, temporary_grants: [liveGrant] }}
        onJitExpired={() => undefined}
        onJitExit={() => undefined}
      />,
    );
    expect(withGrant).toContain('aria-label="受控会话"');
    expect(withGrant).toContain("退出受控会话");
    expect(withGrant).toContain('aria-label="退出受控会话并清除本机已加载的授权数据"');

    const withoutExitHandler = renderToStaticMarkup(
      <OpsHeader {...base} session={{ ...base.session, temporary_grants: [liveGrant] }} />,
    );
    expect(withoutExitHandler).toContain("受控会话 · 只读");
    expect(withoutExitHandler).not.toContain("退出受控会话");
  });

  it("keeps account identity and workbench label on one horizontal row", async () => {
    const styles = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../styles.css", import.meta.url), "utf8"),
    );
    expect(styles).toMatch(/\.ops-account-trigger-copy\s*\{[^}]*display:\s*flex/s);
    expect(styles).toMatch(/\.ops-account-trigger\s*\{[^}]*width:\s*132px/s);
  });
});

// Real Chromium mounts the header and performs the logout fetch. Only the
// logout response is simulated: this is UI regression evidence, not API proof.
describe("ops header logout failure feedback", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-header-logout-"));
    const entryPath = "/__ops-header-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
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
        name: "ops-header-logout-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { OpsHeader } from '/src/components/OpsHeader.tsx';
            import { createAuthorizationProjection } from '/src/authz/authorization.ts';
            sessionStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            const session = {
              actor_id: 'ops-actor-1',
              account_login: 'ops@example.com',
              workspace_id: '',
              roles: ['platform_ops'],
              workbench: 'platform',
              workspace_granted: false,
              scope: { type: 'platform' },
            };
            // ?alerts=1 selects the scope the console reaches with
            // ?workbench=workspace: a platform-scoped session whose active
            // workbench is the merchant one, so both notification surfaces show.
            const withAlerts = new URLSearchParams(window.location.search).get('alerts') === '1';
            const alert = {
              id: 'alert-1', code: 'PUBLISH_STALLED', severity: 'high', platform: 'taobao',
              entityType: 'publish_batch', entityId: 'batch_1', title: '发布批次卡住',
              status: 'open', observedAt: '2026-09-19T02:00:00.000Z', evidence: {}, nextAction: '人工处理',
            };
            function Harness() {
              const [refreshed, setRefreshed] = useState(false);
              return React.createElement(App, null,
                React.createElement(OpsHeader, {
                  managedSession: false,
                  sessionLoaded: true,
                  session,
                  onRefresh: () => setRefreshed(true),
                  ...(withAlerts ? {
                    authorization: createAuthorizationProjection(session, false),
                    activeWorkbench: 'workspace',
                    alerts: [alert],
                    notifications: [],
                  } : {}),
                }),
                React.createElement('span', { 'data-testid': 'refreshed' }, refreshed ? '已刷新' : '未刷新'));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__ops-header-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Ops header listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  async function openAccountPanel(page: Awaited<ReturnType<Browser["newPage"]>>) {
    await page.goto(`${baseUrl}/__ops-header-test`);
    await page.getByRole("button", { name: "打开账号信息", exact: true }).click();
    await page.getByRole("button", { name: /退出登录/u }).waitFor();
  }

  it("reports a rejected logout in the open account panel instead of dropping it", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.route("**/v1/auth/logout", route => route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "网关不可用" } }),
      }));
      await openAccountPanel(page);
      await page.getByRole("button", { name: /退出登录/u }).click();
      const alert = page.getByRole("alert").filter({ hasText: "退出登录失败" });
      await alert.waitFor();
      expect(await alert.isVisible()).toBe(true);
      expect(await alert.innerText()).toContain("退出登录失败（HTTP 502）");
      // The failure is not dressed up as a success: the session stays and the
      // console is not refreshed.
      expect(await page.getByText("ops@example.com", { exact: false }).count()).toBeGreaterThan(0);
      expect(await page.getByTestId("refreshed").innerText()).toBe("未刷新");
    } finally { await page.close(); }
  }, 45_000);

  it("still logs out and refreshes when the server accepts the logout", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.route("**/v1/auth/logout", route => route.fulfill({ status: 204, body: "" }));
      await openAccountPanel(page);
      await page.getByRole("button", { name: /退出登录/u }).click();
      await expect.poll(() => page.getByTestId("refreshed").innerText()).toBe("已刷新");
      expect(await page.getByRole("alert").filter({ hasText: "退出登录失败" }).count()).toBe(0);
    } finally { await page.close(); }
  }, 45_000);

  it("shows the same unread alerts in the account menu as in the bell badge", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/__ops-header-test?alerts=1`);
      // The bell counts the alert the console read...
      const bell = page.getByRole("button", { name: /通知消息/u });
      await expect.poll(() => bell.getAttribute("aria-label")).toContain("1 条未读");
      await page.getByRole("button", { name: "打开账号信息", exact: true }).click();
      const messageCenter = page.locator(".ops-account-message-center");
      await messageCenter.waitFor();
      // ...so the account menu must not answer the same click with 「暂无消息」.
      await expect.poll(() => page.locator(".ops-account-message-heading").innerText()).toContain("1 条消息");
      const text = await messageCenter.innerText();
      expect(text).toContain("发布批次卡住");
      expect(text).not.toContain("暂无消息");
    } finally { await page.close(); }
  }, 45_000);
});
