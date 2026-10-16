import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Ops merchant invitation authorization lifecycle", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-invitation-authorization-"));
    const entryPath = "/__invitation-authorization-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"),
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("oidc"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("oidc"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "isolated-invitation-authorization",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { UsersPage } from '/src/pages/UsersPage.tsx';
            localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'fixture-token', actorId: 'fixture-operator' }));
            function Fixture() {
              if (!window.__requests) window.__requests = [];
              const query=new URLSearchParams(location.search);const [allowed,setAllowed]=useState(query.get('compat')!=='false');const [role,setRole]=useState(query.get('role')||'ops_admin');const scope=query.get('scope')||'platform';const [actor,setActor]=useState('fixture-operator');window.__changeInvitationIdentity=change=>change==='revoke'?(setAllowed(false),setRole('finance_ops')):change==='role'?setRole('finance_ops'):setActor('fixture-other');const [directory, setDirectory] = useState({items: [], offset: 0, limit: 100, hasMore: false});
              const model = {
                authorization: {can: capability => ['identity.read','commercial.update'].includes(capability), canAny: () => false, roles: [role], scope: {kind: scope}},
                userDirectory: {items: [], total: 0, identityCount: 0, workspaceCount: 0, offset: 0, limit: 20, truncated: false},
                userDirectoryLoading: false, userDirectoryError: '', userExporting: false,
                canPlatformOps: allowed, canUserGovernance: false, userDetail: undefined, userDetailLoading: false,
                opsSession: {actor_id: actor, workbench: scope}, error: undefined, load: async () => undefined,
                loadUsers: async () => undefined, cancelUserRequests: () => undefined,
                workspaceDirectoryLoading: false, workspaceDirectoryError: '',
                get workspaceDirectory() { return directory; },
                loadWorkspaceDirectory: async filters => {
                  window.__requests.push(filters);
                  const row = {workspaceId: 'ws_workspace_101', enterpriseName: '第101家目标企业', status: 'active'};
                  setDirectory({items: filters.query ? [row] : [], offset: 0, limit: 100, hasMore: false});
                  return true;
                },
              };
              return React.createElement(App, null, React.createElement(UsersPage, {model}));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Fixture));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/ops/users")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Provision workspace search listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally { try { await vite?.close(); } finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); } }
  }, 60_000);

  it.each(["revoke", "subject", "late", "role"])("removes invitation after %s",async change=>{
    const page=await browser!.newPage();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let requested=false;
    try{
      await page.route("**/api/v1/ops/merchant-accounts",async route=>{requested=true;if(change==="late")await gate;await route.fulfill({contentType:"application/json",body:JSON.stringify({data:{account:{id:"fixture",login:"buyer@example.com",workspaceIds:["ws_fixture"],status:"invited"},invitation:{id:"owned_invite_fixture",expires_at:"2027-01-01T00:00:00Z",status:"pending",activation_link:"https://fixture.invalid/activate#token=owned-fixture",replayed:false,delivery_status:"not_sent"}}})})});
      await page.goto(`${baseUrl}/ops/users`);await page.getByRole("button",{name:/更多用户治理操作/}).click();await page.getByRole("menuitem",{name:"开通商家账号"}).click();const dialog=page.getByRole("dialog",{name:"邀请客户激活登录账号"});
      await dialog.getByLabel("商家登录邮箱").fill("buyer@example.com");await dialog.getByLabel("企业名称").fill("测试企业");await dialog.getByLabel("联系人").fill("测试联系人");await dialog.getByLabel("开户或邀请原因").fill("受控授权边界验证");await dialog.getByRole("button",{name:"创建账号与安全邀请"}).click();
      if(change!=="late")await dialog.getByText("owned_invite_fixture",{exact:true}).waitFor();else await page.waitForFunction(()=>!!document.querySelector('.ant-btn-loading'));
      expect(requested).toBe(true);await page.evaluate(change=>window.__changeInvitationIdentity(change==='late'?'revoke':change),change);release();await page.getByRole("dialog",{name:"邀请客户激活登录账号"}).waitFor({state:"hidden",timeout:5000});
      expect(await page.getByRole("dialog",{name:"邀请客户激活登录账号"}).count()).toBe(0);expect(await page.getByText("owned_invite_fixture",{exact:true}).count()).toBe(0);
    }finally{release();await page.close()}
  },60000);

  it.each([
    ["finance_ops", "platform"],
    ["operator", "platform"],
    ["platform_ops", "workspace"],
    ["ops_admin", "workspace"],
  ])("disables the invitation action for %s in %s even with commercial write compatibility", async (role, scope) => {
    const page = await browser!.newPage();
    let writes = 0;
    try {
      await page.route("**/api/v1/ops/merchant-accounts", async route => { writes++; await route.abort(); });
      await page.goto(`${baseUrl}/ops/users?role=${role}&scope=${scope}`);
      await page.getByRole("button", { name: /更多用户治理操作/ }).click();
      const action = page.getByRole("menuitem", { name: "开通商家账号" });
      expect(await action.isDisabled()).toBe(true);
      expect(await page.getByRole("dialog", { name: "邀请客户激活登录账号" }).count()).toBe(0);
      expect(writes).toBe(0);
    } finally { await page.close(); }
  }, 60000);

  it.each(["ops_admin", "platform_admin", "platform_ops"])("enables the invitation action for platform %s independently of the commercial compatibility flag", async role => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/ops/users?role=${role}&scope=platform&compat=false`);
      await page.getByRole("button", { name: /更多用户治理操作/ }).click();
      const action = page.getByRole("menuitem", { name: "开通商家账号" });
      expect(await action.isDisabled()).toBe(false);
      await action.click();
      await page.getByRole("dialog", { name: "邀请客户激活登录账号" }).waitFor();
    } finally { await page.close(); }
  }, 60000);

});

declare global { interface Window { __changeInvitationIdentity: (change:string)=>void } }
