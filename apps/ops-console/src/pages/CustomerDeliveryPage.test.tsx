import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { customerDeliveryWorkspaceOptions, isCustomerDeliveryRevisionConflict } from "./CustomerDeliveryPage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const pageSource = readFileSync(new URL("./CustomerDeliveryPage.tsx", import.meta.url), "utf8");

describe("customer delivery workspace selection", () => {
  it("labels workspaces with enterprise identity and blocks disabled workspaces", () => {
    expect(customerDeliveryWorkspaceOptions([
      { workspaceId: "ws_active", enterpriseName: "Store Nova测试商家", status: "active", planName: "专业版", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 100, subscriptionStatus: "active", memberCount: 1 },
      { workspaceId: "ws_disabled", enterpriseName: "已停用商家", status: "disabled", planName: "基础版", monthlyPriceCny: 0, usedTasks: 0, includedTasks: 10, subscriptionStatus: "inactive", memberCount: 0 },
    ])).toEqual([
      { value: "ws_active", label: "Store Nova测试商家 · ws_active", disabled: false },
      { value: "ws_disabled", label: "已停用商家 · ws_disabled", disabled: true },
    ]);
  });

  it("uses the shared platform workspace without exposing a tenant selector", () => {
    expect(pageSource).not.toContain('aria-label="客户交付目标企业工作区"');
    expect(pageSource).not.toContain("model.setAuthorizationTargetWorkspaceId");
    expect(pageSource).toContain('model.authorization.can("customer.delivery.update")');
    expect(pageSource).toContain("disabled={!canRead || !targetWorkspaceId}");
    expect(pageSource).toContain('const targetWorkspaceId = model.authorizationTargetWorkspaceId?.trim() || model.workspaceRows[0]?.workspaceId || ""');
    expect(pageSource).toContain('key={targetWorkspaceId || "unselected"}');
    expect(pageSource).toContain("setRecords([])");
  });

  it("uploads real contract and video assets and resumes an interrupted draft", () => {
    expect(pageSource).toContain('purpose: "contract"');
    expect(pageSource).toContain('purpose: "video"');
    expect(pageSource).toContain("const existingDraft = records.find");
    expect(pageSource).toContain("pendingCreate.current = attempt");
    expect(pageSource).toContain("poll >= 15");
  });

  it("recognizes stale-record conflicts so checklist and training saves can refresh once", () => {
    expect(isCustomerDeliveryRevisionConflict(new Error("revision changed"))).toBe(true);
    expect(isCustomerDeliveryRevisionConflict(new Error("REVISION_CONFLICT"))).toBe(true);
    expect(isCustomerDeliveryRevisionConflict(new Error("network unavailable"))).toBe(false);
    expect(pageSource).toContain("currentRecord = await customerDeliveryClient.get");
    expect(pageSource).toContain("const latest = await customerDeliveryClient.get");
  });

  it("uses creation time for launch display and removes the manual launch field", () => {
    expect(pageSource).not.toContain('name="requiredLaunchAt"');
    expect(pageSource).not.toContain("plannedGoLiveAt:");
    expect(pageSource).toContain("customer-delivery-four-char-label");
  });
});

// Real Chromium mounts the page, Ant Design drawers and opsClient. Only RPC
// responses are simulated: this is UI regression evidence, not API/RLS proof.
describe("customer delivery read-only desktop interaction", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-delivery-readonly-"));
    const entryPath = "/__delivery-readonly-entry.tsx";
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
        name: "delivery-readonly-regression",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { CustomerDeliveryPage } from '/src/pages/CustomerDeliveryPage.tsx';
            sessionStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }));
            function Harness() {
              const [write, setWrite] = useState(new URLSearchParams(location.search).get('write') === 'true');
              const [read, setRead] = useState(true);
              const [mounted, setMounted] = useState(true);
              const [workspace, setWorkspace] = useState('ws-readonly');
              const model = {
                authorization: { can: capability => capability === 'customer.delivery.update' ? write : capability === 'customer.delivery.read' ? read : capability === 'workspace.directory.read' },
                authorizationTargetWorkspaceId: workspace,
                setAuthorizationTargetWorkspaceId: setWorkspace,
                loadWorkspaceDirectory: async () => {},
                workspaceDirectoryLoading: false,
                workspaceRows: [{ workspaceId: 'ws-readonly', enterpriseName: '只读客户', status: 'active' }],
              };
              return React.createElement(App, null,
                React.createElement('button', { onClick: () => setWrite(false) }, '撤销测试写权限'),
                React.createElement('button', { onClick: () => setRead(false) }, '撤销测试读权限'),
                React.createElement('button', { onClick: () => setWorkspace('') }, '清除测试工作区'),
                React.createElement('button', { onClick: () => setWorkspace('ws-other') }, '切换测试工作区'),
                React.createElement('button', { onClick: () => setWorkspace('ws-readonly') }, '返回测试工作区'),
                React.createElement('button', { onClick: () => setMounted(false) }, '卸载测试页面'),
                mounted ? React.createElement(CustomerDeliveryPage, { model }) : null);
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__delivery-readonly-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Delivery read-only listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    const logCleanupStage = async (stage: string, action: () => Promise<void>) => {
      const startedAt = Date.now();
      console.info(`[customer-delivery-test-cleanup] stage=${stage} status=started duration_ms=0`);
      try {
        await action();
        console.info(`[customer-delivery-test-cleanup] stage=${stage} status=completed duration_ms=${Date.now() - startedAt}`);
      } catch (error) {
        console.error(`[customer-delivery-test-cleanup] stage=${stage} status=failed duration_ms=${Date.now() - startedAt}`);
        throw error;
      }
    };
    try { await logCleanupStage("browser.close", async () => { await browser?.close(); }); }
    finally {
      try { await logCleanupStage("vite.close", async () => { await vite?.close(); }); }
      finally {
        const directory = cacheDirectory;
        if (directory) await logCleanupStage("cache.rm", async () => { await rm(directory, { recursive: true, force: true }); });
      }
    }
  }, 60_000);

  const record = {
    id: "delivery-readonly", companyName: "只读客户", paymentStatus: "paid",
    customerProfileStatus: "complete", systemIntegrationStatus: "complete", functionalAcceptanceStatus: "complete",
    trainingCompleted: true, revision: 4,
    contractNumber: "READ-2026", contractRef: "asset:contract", projectOwner: "项目负责人甲", supportOwner: "售后负责人乙",
    paymentDate: "2026-09-14", paymentEvidenceRefs: ["asset:payment"], plannedGoLiveAt: "2026-09-16T02:00:00.000Z",
    trainingEvidenceRefs: ["asset:training"], videos: [{ id: "video-1", title: "第一段交付", assetRef: "asset:video", sortOrder: 0 }],
  };
  async function prepare(page: Page, options: {
    unpaid?: boolean;
    write?: boolean;
    onVideoAdd?: (params: Record<string, string>) => Promise<void>;
    onGet?: (params: Record<string, string>) => Promise<unknown>;
    onList?: (workspaceId: string) => unknown[];
    onMutation?: (method: string, params: Record<string, string>) => Promise<unknown>;
    failVideoRefresh?: boolean;
  } = {}) {
    const methods: string[] = [];
    const videos = record.videos.map(video => ({ ...video }));
    await page.route(`${baseUrl}/api/mcp`, async route => {
      const request = route.request().postDataJSON() as { id: string; method: string; params: Record<string, string> };
      methods.push(request.method);
      let result: unknown;
      if (request.method === "ops.customer-delivery.list") result = { items: options.onList?.(request.params.target_workspace_id!) ?? [{ ...record, videos, paymentStatus: options.unpaid ? "unpaid" : "paid" }] };
      else if (request.method === "ops.customer-delivery.checklist-items.list") result = { items: [{ itemKey: request.params.checklist_key === "system_integration" ? "插件账号" : "文案生成", completed: true, evidence: { note: "已保存的检查记录", asset_refs: ["asset:checklist"] } }] };
      else if (request.method === "ops.customer-delivery.videos.list") result = { items: videos };
      else if (request.method === "ops.customer-delivery.get" && options.failVideoRefresh) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "测试中的详情读取暂时不可用" } }) });
      else if (request.method === "ops.customer-delivery.get") result = options.onGet ? await options.onGet(request.params) : { ...record, videos, revision: record.revision + videos.length - 1 };
      else if (request.method === "ops.customer-delivery.videos.add" && options.onVideoAdd) {
        await options.onVideoAdd(request.params);
        const video = { id: `video-${videos.length + 1}`, title: request.params.title!, assetRef: request.params.asset_ref!, sortOrder: Number(request.params.sort_order) };
        videos.push(video);
        result = video;
      }
      else if (options.onMutation) result = await options.onMutation(request.method, request.params);
      else return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Read-only test does not allow mutations" } }) });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
    });
    await page.goto(`${baseUrl}/__delivery-readonly-test?write=${options.write === true}`);
    await page.getByRole("cell", { name: "只读客户", exact: true }).waitFor();
    return methods;
  }

  const row = (page: Page) => page.getByRole("row").filter({ has: page.getByRole("cell", { name: "只读客户", exact: true }) });
  const account = { workspaceId: "ws-readonly", accountId: "private-account-1", identityId: "private-identity-1", login: "merchant-one@example.test" };
  const account2 = { ...account, accountId: "private-account-2", identityId: "private-identity-2", login: "merchant-two@example.test" };
  const boundRecord = { ...record, workspaceId: "ws-readonly", revision: 5, targetAccountId: account.accountId, targetIdentityId: account.identityId, targetAccountLogin: account.login };
  async function openAccountBinding(page: Page, editable = true) {
    await row(page).getByRole("button", { name: editable ? "编辑档案" : "查看详情", exact: true }).click();
    await page.getByRole("region", { name: "生效账号", exact: true }).waitFor();
  }
  async function selectAccount(page: Page, login = account.login) {
    await page.getByRole("button", { name: "查询账号", exact: true }).click();
    await expect.poll(() => page.getByRole("combobox", { name: "选择生效账号", exact: true }).isEnabled()).toBe(true);
    await page.getByRole("combobox", { name: "选择生效账号", exact: true }).click();
    await page.locator(".ant-select-item-option-content").filter({ hasText: login }).click();
  }

  it("shows a bound login but no internal identifiers or binding controls to read-only operators", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const methods = await prepare(page, { onList: () => [boundRecord] });
      await openAccountBinding(page, false);
      const section = page.getByRole("region", { name: "生效账号", exact: true });
      expect(await section.innerText()).toContain(account.login);
      expect(await section.innerText()).not.toContain(account.accountId);
      expect(await section.innerText()).not.toContain(account.identityId);
      expect(await section.getByRole("button").count()).toBe(0);
      expect(methods).toEqual(["ops.customer-delivery.list", "ops.customer-delivery.videos.list"]);
    } finally { await page.close(); }
  }, 45_000);

  it("requires an explicit scoped account selection and confirmation, keeps pagination and saves the new revision", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const calls: Array<{ method: string; params: Record<string, string> }> = [];
    try {
      const methods = await prepare(page, { write: true, onMutation: async (method, params) => {
        calls.push({ method, params });
        if (method === "ops.customer-delivery.accounts.list") return params.cursor ? { items: [account2] } : { items: [account], nextCursor: "page-2" };
        if (method === "ops.customer-delivery.account.bind") return boundRecord;
        if (method === "ops.customer-delivery.update") return { ...boundRecord, ...JSON.parse(params.patch_json!), revision: 6 };
        throw new Error(`Unexpected method ${method}`);
      } });
      await openAccountBinding(page);
      expect(methods).toEqual(["ops.customer-delivery.list"]);
      await page.getByLabel("合同编号", { exact: true }).fill("UNSAVED-PRESERVED");
      await selectAccount(page);
      await page.getByRole("button", { name: "加载更多账号", exact: true }).click();
      await expect.poll(() => calls.filter(call => call.method.endsWith("accounts.list")).length).toBe(2);
      await expect.poll(() => page.getByRole("combobox", { name: "选择生效账号", exact: true }).isEnabled()).toBe(true);
      await page.getByRole("combobox", { name: "选择生效账号", exact: true }).click();
      await page.locator(".ant-select-item-option-content").filter({ hasText: account2.login }).waitFor();
      await page.getByRole("combobox", { name: "选择生效账号", exact: true }).press("Escape");
      expect(calls.some(call => call.method.endsWith("account.bind"))).toBe(false);
      await page.getByRole("button", { name: "确认关联账号", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "请填写 3–1000 字的关联原因" }).waitFor();
      await page.getByLabel("关联原因（必填）", { exact: true }).fill("已核对商家登录账号");
      await page.getByRole("checkbox", { name: `我已核对登录账号，确认关联 ${account.login}`, exact: true }).check();
      await page.getByRole("button", { name: "确认关联账号", exact: true }).click();
      await page.getByText("已关联，仅此账号受该交付档案的完成状态约束。", { exact: false }).waitFor();
      expect(await page.getByLabel("合同编号", { exact: true }).inputValue()).toBe("UNSAVED-PRESERVED");
      await page.getByRole("button", { name: "保存当前环节", exact: true }).click();
      await expect.poll(() => calls.filter(call => call.method === "ops.customer-delivery.update").length).toBe(1);
      expect(calls.filter(call => call.method.endsWith("accounts.list")).map(call => call.params)).toEqual([
        { target_workspace_id: "ws-readonly", limit: "25" },
        { target_workspace_id: "ws-readonly", cursor: "page-2", limit: "25" },
      ]);
      expect(calls.find(call => call.method.endsWith("account.bind"))?.params).toEqual({ target_workspace_id: "ws-readonly", delivery_id: record.id, target_account_id: account.accountId, expected_revision: "4", reason: "已核对商家登录账号" });
      const saved = calls.find(call => call.method === "ops.customer-delivery.update")?.params;
      expect(saved?.expected_revision).toBe("5");
      expect(JSON.parse(saved!.patch_json!)).toMatchObject({ contractNumber: "UNSAVED-PRESERVED" });
      expect(JSON.parse(saved!.patch_json!)).not.toHaveProperty("targetAccountId");
    } finally { await page.close(); }
  }, 60_000);

  it.each(["write", "read", "workspace", "unmount", "close", "cancel"] as const)("ignores a late account binding after %s interruption", async interruption => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let returned = false;
    try {
      const methods = await prepare(page, { write: true, onMutation: async (method) => {
        if (method.endsWith("accounts.list")) return { items: [account] };
        if (method.endsWith("account.bind")) { await gate; returned = true; return boundRecord; }
        throw new Error(`Unexpected ${method}`);
      } });
      await openAccountBinding(page); await selectAccount(page);
      await page.getByLabel("关联原因（必填）", { exact: true }).fill("已核对商家登录账号");
      await page.getByRole("checkbox", { name: `我已核对登录账号，确认关联 ${account.login}`, exact: true }).check();
      await page.getByRole("button", { name: "确认关联账号", exact: true }).click();
      await expect.poll(() => methods.filter(method => method.endsWith("account.bind")).length).toBe(1);
      if (interruption === "close") await closeDrawer(page);
      else if (interruption === "cancel") await page.getByRole("button", { name: "取消等待", exact: true }).click();
      else {
        const control = { write: "撤销测试写权限", read: "撤销测试读权限", workspace: "切换测试工作区", unmount: "卸载测试页面" }[interruption];
        // The isolated harness lifecycle control is intentionally outside the modal.
        await page.getByRole("button", { name: control, exact: true }).evaluate(element => (element as HTMLButtonElement).click());
      }
      release!(); await expect.poll(() => returned).toBe(true);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.getByText("已关联，仅此账号受该交付档案的完成状态约束。", { exact: false }).count()).toBe(0);
      expect(methods.filter(method => method.endsWith("account.bind"))).toHaveLength(1);
      expect(methods.filter(method => method === "ops.customer-delivery.get")).toHaveLength(0);
      if (interruption === "cancel") expect(await page.getByRole("region", { name: "生效账号", exact: true }).getByRole("status").innerText()).toContain("取消不会撤销已保存的关联");
    } finally { release?.(); await page.close(); }
  }, 45_000);

  it("retrying an account search after selection never invokes binding", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    let searches = 0;
    try {
      const methods = await prepare(page, { write: true, onMutation: async (method) => {
        if (!method.endsWith("accounts.list")) throw new Error(`Unexpected write ${method}`);
        searches++;
        return searches === 2 ? { items: [{ ...account, workspaceId: "wrong-workspace" }] } : { items: [account] };
      } });
      await openAccountBinding(page); await selectAccount(page);
      await page.getByLabel("关联原因（必填）", { exact: true }).fill("已核对商家登录账号");
      await page.getByRole("checkbox", { name: `我已核对登录账号，确认关联 ${account.login}`, exact: true }).check();
      await page.locator("#delivery-account-search").press("Enter");
      await page.getByRole("alert").filter({ hasText: "账号查询失败" }).waitFor();
      await page.getByRole("button", { name: "重新查询", exact: true }).click();
      await expect.poll(() => searches).toBe(3);
      expect(methods.some(method => method.endsWith("account.bind"))).toBe(false);
      expect(await page.getByRole("checkbox", { name: `我已核对登录账号，确认关联 ${account.login}`, exact: true }).isChecked()).toBe(false);
    } finally { await page.close(); }
  }, 45_000);

  it.each(["identity", "revision"] as const)("rejects a mismatched account %s response without showing success", async mismatch => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const methods = await prepare(page, { write: true, onMutation: async method => {
        if (method.endsWith("accounts.list")) return { items: [account] };
        if (method.endsWith("account.bind")) return { ...boundRecord, ...(mismatch === "identity" ? { targetIdentityId: "wrong-identity" } : { revision: 4 }) };
        throw new Error(`Unexpected ${method}`);
      } });
      await openAccountBinding(page); await selectAccount(page);
      await page.getByLabel("关联原因（必填）", { exact: true }).fill("已核对商家登录账号");
      await page.getByRole("checkbox", { name: `我已核对登录账号，确认关联 ${account.login}`, exact: true }).check();
      await page.getByRole("button", { name: "确认关联账号", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "关联未确认成功" }).waitFor();
      expect(await page.getByText("已关联，仅此账号受该交付档案的完成状态约束。", { exact: false }).count()).toBe(0);
      expect(methods.filter(method => method.endsWith("account.bind"))).toHaveLength(1);
      expect(await page.getByRole("region", { name: "生效账号", exact: true }).innerText()).not.toContain("wrong-identity");
      await closeDrawer(page); await openAccountBinding(page);
      expect(await page.getByRole("region", { name: "生效账号", exact: true }).innerText()).toContain("未关联");
    } finally { await page.close(); }
  }, 45_000);

  it("does not expose an older account search after a new query wins", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let queries = 0;
    let returned = false;
    try {
      await prepare(page, { write: true, onMutation: async (method, params) => {
        if (!method.endsWith("accounts.list")) throw new Error(`Unexpected ${method}`);
        queries++;
        if (params.search === "old") { await gate; returned = true; return { items: [account] }; }
        return { items: [account2] };
      } });
      await openAccountBinding(page);
      await page.getByLabel("查找商家登录账号", { exact: true }).fill("old");
      await page.getByRole("button", { name: "查询账号", exact: true }).click();
      await expect.poll(() => queries).toBe(1);
      await page.getByLabel("查找商家登录账号", { exact: true }).fill("new");
      await page.getByLabel("查找商家登录账号", { exact: true }).press("Enter");
      await expect.poll(() => queries).toBe(2);
      release!(); await expect.poll(() => returned).toBe(true);
      await expect.poll(() => page.getByRole("combobox", { name: "选择生效账号", exact: true }).isEnabled()).toBe(true);
      await page.getByRole("combobox", { name: "选择生效账号", exact: true }).click();
      await page.locator(".ant-select-item-option-content").filter({ hasText: account2.login }).waitFor();
      expect(await page.locator(".ant-select-item-option-content").filter({ hasText: account.login }).count()).toBe(0);
    } finally { release?.(); await page.close(); }
  }, 45_000);
  async function closeDrawer(page: Page) {
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  async function assertNoWrites(page: Page, methods: string[]) {
    expect(await page.locator('input[type="file"]').count()).toBe(0);
    expect(await page.getByRole("button", { name: "保存当前环节", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "确认培训完成", exact: true }).count()).toBe(0);
    expect(methods.every(method => ["ops.customer-delivery.list", "ops.customer-delivery.checklist-items.list", "ops.customer-delivery.videos.list"].includes(method))).toBe(true);
  }

  it.each([false, true])("opens every saved detail without mutations (unpaid=%s)", async unpaid => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const methods = await prepare(page, { unpaid });
      const overview = row(page);
      await expect.poll(() => overview.getByRole("button", { name: "已完成", exact: true }).first().isEnabled()).toBe(true);
      await overview.getByRole("button", { name: "已完成", exact: true }).nth(0).click();
      await page.getByRole("dialog").waitFor();
      expect(await page.getByLabel("合同编号", { exact: true }).inputValue()).toBe("READ-2026");
      expect(await page.getByLabel("合同编号", { exact: true }).isDisabled()).toBe(true);
      await assertNoWrites(page, methods);
      await closeDrawer(page);
      for (const index of [1, 2]) {
        await overview.getByRole("button", { name: "已完成", exact: true }).nth(index).click();
        await expect.poll(() => page.getByRole("dialog").getByPlaceholder("可选：记录链接、单号或补充说明").first().inputValue()).toBe("已保存的检查记录");
        await assertNoWrites(page, methods);
        await closeDrawer(page);
      }
      await overview.getByRole("button", { name: "凭证", exact: true }).click();
      await page.getByRole("region", { name: "只读客户 培训凭证", exact: true }).waitFor();
      expect(await page.getByLabel("已上传培训凭证", { exact: true }).isDisabled()).toBe(true);
      expect(await page.getByText("asset:training", { exact: true }).isVisible()).toBe(true);
      await assertNoWrites(page, methods);
      await page.getByRole("button", { name: "收起", exact: true }).click();
      await overview.getByRole("button", { name: "1 段", exact: true }).click();
      await page.getByText("第一段交付", { exact: true }).waitFor();
      await assertNoWrites(page, methods);
      expect(await page.getByText("用户尚未完成付款", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  }, 45_000);

  it("removes all mutation entries when write permission is revoked while a drawer is open", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const methods = await prepare(page, { write: true });
      await row(page).getByRole("button", { name: "编辑档案", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      expect(await page.locator('input[type="file"]').count()).toBe(2);
      // Harness control changes the real React model without navigating away.
      await page.getByRole("button", { name: "撤销测试写权限", exact: true }).evaluate(element => (element as HTMLButtonElement).click());
      await page.getByText("当前会话仅可查看客户交付", { exact: true }).waitFor();
      await expect.poll(() => page.locator('input[type="file"]').count()).toBe(0);
      expect(await page.getByLabel("合同编号", { exact: true }).isDisabled()).toBe(true);
      // Native form submission cannot bypass the read-only action guard.
      await page.getByRole("dialog").locator("form").evaluate(element => (element as HTMLFormElement).requestSubmit());
      await assertNoWrites(page, methods);
      await closeDrawer(page);
      await row(page).getByRole("button", { name: "1 段", exact: true }).click();
      await page.getByText("第一段交付", { exact: true }).waitFor();
      await assertNoWrites(page, methods);
    } finally { await page.close(); }
  }, 45_000);

  it("retains expanded training evidence but removes its upload and confirmation after write revocation", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const methods = await prepare(page, { write: true });
      await row(page).getByRole("button", { name: "凭证", exact: true }).click();
      await page.getByRole("button", { name: "确认培训完成", exact: true }).waitFor();
      expect(await page.locator('input[type="file"]').count()).toBe(1);
      await page.getByRole("button", { name: "撤销测试写权限", exact: true }).click();
      await page.getByText("当前会话仅可查看客户交付", { exact: true }).waitFor();
      await expect.poll(() => page.locator('input[type="file"]').count()).toBe(0);
      expect(await page.getByText("asset:training", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByLabel("已上传培训凭证", { exact: true }).isDisabled()).toBe(true);
      await assertNoWrites(page, methods);
      await page.getByRole("button", { name: "收起", exact: true }).click();
      await page.getByRole("region", { name: "只读客户 培训凭证", exact: true }).waitFor({ state: "hidden" });
      await assertNoWrites(page, methods);
    } finally { await page.close(); }
  }, 45_000);

  it.each(["write", "read", "drawer", "workspace", "unmount"] as const)("stops the remaining video writes after %s changes during the first response", async interruption => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const writes: Record<string, string>[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
    try {
      const methods = await prepare(page, { write: true, onVideoAdd: async params => {
        writes.push(params);
        if (writes.length === 1) await firstResponse;
      } });
      await row(page).getByRole("button", { name: "1 段", exact: true }).click();
      const pendingRefs = page.getByLabel("交付视频（支持多段）", { exact: true });
      await pendingRefs.fill("asset:new-first\nasset:new-second");
      await page.getByRole("button", { name: "保存当前环节", exact: true }).click();
      await expect.poll(() => writes.length).toBe(1);
      if (interruption === "drawer") await closeDrawer(page);
      else {
        const action = { write: "撤销测试写权限", read: "撤销测试读权限", workspace: "清除测试工作区", unmount: "卸载测试页面" }[interruption];
        await page.getByRole("button", { name: action, exact: true }).evaluate(element => (element as HTMLButtonElement).click());
        if (interruption === "write") await page.getByText("当前会话仅可查看客户交付", { exact: true }).waitFor();
        if (interruption === "read") await page.getByText("当前会话没有客户交付读取权限", { exact: true }).waitFor();
        if (interruption === "workspace") await page.getByText("请选择目标企业工作区后开始客户交付", { exact: true }).waitFor();
        if (interruption === "unmount") await page.getByRole("heading", { name: "客户交付", exact: true }).waitFor({ state: "hidden" });
      }
      // The already-sent segment is durably acknowledged. Do not roll it back.
      const acknowledged = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === "ops.customer-delivery.videos.add");
      const mayRead = interruption === "write" || interruption === "drawer";
      const reconciled = mayRead ? page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === "ops.customer-delivery.get") : undefined;
      releaseFirst!();
      await (await acknowledged).finished();
      if (reconciled) await (await reconciled).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(writes.map(input => input.asset_ref)).toEqual(["asset:new-first"]);
      expect(methods.filter(method => method === "ops.customer-delivery.get")).toHaveLength(mayRead ? 1 : 0);
      if (!mayRead) await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
      if (interruption === "write") {
        await expect.poll(() => pendingRefs.inputValue()).toBe("asset:new-second");
        await closeDrawer(page);
        await row(page).getByRole("button", { name: "2 段", exact: true }).click();
        await page.getByText("只读客户 交付视频 2", { exact: true }).waitFor();
        expect(writes).toHaveLength(1);
      }
    } finally { releaseFirst?.(); await page.close(); }
  }, 45_000);

  it("does not let a delayed video refresh overwrite A after switching A to B and back to A", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    let releaseOldGet: (() => void) | undefined;
    const oldGetGate = new Promise<void>(resolve => { releaseOldGet = resolve; });
    let revisited = false;
    const writes: string[] = [];
    try {
      await prepare(page, {
        write: true,
        onVideoAdd: async params => { writes.push(params.asset_ref!); },
        onGet: async () => { await oldGetGate; return { ...record, companyName: "过期的客户名称", videos: [...record.videos, { id: "v-old", title: "已登记首段", assetRef: "asset:new-first", sortOrder: 1 }] }; },
        onList: workspaceId => workspaceId === "ws-other"
          ? [{ ...record, id: "other-delivery", companyName: "其他企业" }]
          : [{ ...record, companyName: revisited ? "重新加载的客户名称" : record.companyName }],
      });
      await row(page).getByRole("button", { name: "1 段", exact: true }).click();
      await page.getByLabel("交付视频（支持多段）", { exact: true }).fill("asset:new-first\nasset:new-second");
      const getRequested = page.waitForRequest(request => request.url().endsWith("/api/mcp") && request.postDataJSON().method === "ops.customer-delivery.get");
      await page.getByRole("button", { name: "保存当前环节", exact: true }).click();
      const oldRequest = await getRequested;
      const oldRequestSettled = new Promise<void>(resolve => {
        const finish = (request: import("playwright").Request) => {
          if (request !== oldRequest) return;
          page.off("requestfinished", finish);
          page.off("requestfailed", finish);
          resolve();
        };
        page.on("requestfinished", finish);
        page.on("requestfailed", finish);
      });
      await page.getByRole("button", { name: "切换测试工作区", exact: true }).evaluate(element => (element as HTMLButtonElement).click());
      await page.getByRole("cell", { name: "其他企业", exact: true }).waitFor();
      revisited = true;
      await page.getByRole("button", { name: "返回测试工作区", exact: true }).click();
      await page.getByRole("cell", { name: "重新加载的客户名称", exact: true }).waitFor();
      releaseOldGet!();
      await oldRequestSettled;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.getByRole("cell", { name: "重新加载的客户名称", exact: true }).count()).toBe(1);
      expect(await page.getByRole("cell", { name: "过期的客户名称", exact: true }).count()).toBe(0);
      expect(writes).toEqual(["asset:new-first"]);
      expect(await page.getByRole("dialog").count()).toBe(0);
    } finally { releaseOldGet?.(); await page.close(); }
  }, 45_000);

  it("continues a writable two-video batch exactly once per segment", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const writes: Record<string, string>[] = [];
    try {
      await prepare(page, { write: true, onVideoAdd: async params => { writes.push(params); } });
      await row(page).getByRole("button", { name: "1 段", exact: true }).click();
      const pendingRefs = page.getByLabel("交付视频（支持多段）", { exact: true });
      await pendingRefs.fill("asset:new-first\nasset:new-second");
      await page.getByRole("button", { name: "保存当前环节", exact: true }).click();
      await page.getByText("已保存", { exact: true }).waitFor();
      expect(writes.map(input => [input.asset_ref, input.sort_order])).toEqual([["asset:new-first", "1"], ["asset:new-second", "2"]]);
      expect(await pendingRefs.inputValue()).toBe("");
      await page.getByRole("button", { name: "保存当前环节", exact: true }).click();
      await page.getByText("请填写至少一个已上传视频的 asset_ref", { exact: true }).waitFor();
      expect(writes).toHaveLength(2);
    } finally { await page.close(); }
  }, 45_000);

  it("keeps an acknowledged video registered when its detail refresh fails", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const writes: string[] = [];
    try {
      await prepare(page, { write: true, failVideoRefresh: true, onVideoAdd: async params => { writes.push(params.asset_ref!); } });
      await row(page).getByRole("button", { name: "1 段", exact: true }).click();
      const pendingRefs = page.getByLabel("交付视频（支持多段）", { exact: true });
      await pendingRefs.fill("asset:acknowledged-video");
      await page.getByRole("button", { name: "保存当前环节", exact: true }).click();
      await page.getByText(/视频已登记，但最新档案读取失败。请刷新档案，不要重复登记/u).waitFor();
      await page.getByText("已保存", { exact: true }).waitFor();
      expect(await pendingRefs.inputValue()).toBe("");
      // Ant Design's invisible leaving spinner can retain the accessible name
      // "loading" after saving ends. Select the same native submit in the
      // readable dialog, then verify readiness before a normal user click.
      const form = page.getByRole("dialog").locator("form");
      const submit = form.locator('button[type="submit"]');
      expect(await submit.count()).toBe(1);
      await expect.poll(() => form.getAttribute("aria-busy")).toBe("false");
      await expect.poll(() => submit.isEnabled()).toBe(true);
      await expect.poll(() => submit.evaluate(button => button.classList.contains("ant-btn-loading"))).toBe(false);
      await submit.click();
      await page.getByText("请填写至少一个已上传视频的 asset_ref", { exact: true }).waitFor();
      expect(writes).toEqual(["asset:acknowledged-video"]);
    } finally { await page.close(); }
  }, 45_000);

  it.each([
    ["profile", "read"], ["profile", "unmount"],
    ["training", "read"], ["training", "unmount"],
    ["create", "read"], ["create", "unmount"],
  ] as const)("does not restart a list after delayed %s success and %s loss", async (action, interruption) => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    let releaseMutation: (() => void) | undefined;
    const mutationGate = new Promise<void>(resolve => { releaseMutation = resolve; });
    const expectedMethod = { profile: "ops.customer-delivery.update", training: "ops.customer-delivery.training.complete", create: "ops.customer-delivery.create" }[action];
    try {
      const methods = await prepare(page, { write: true, onMutation: async (method, params) => {
        if (method !== expectedMethod) throw new Error(`Unexpected mutation: ${method}`);
        await mutationGate;
        return { ...record, ...(action === "create" ? { id: "new-delivery", companyName: params.company_name } : {}), revision: record.revision + 1 };
      } });
      if (action === "profile") {
        await row(page).getByRole("button", { name: "编辑档案", exact: true }).click();
        await page.getByRole("button", { name: "保存当前环节", exact: true }).click();
      } else if (action === "training") {
        // This controlled checkbox stays checked until its real callback
        // succeeds; click starts the pending mutation without assuming success.
        await row(page).getByRole("checkbox", { name: "已完成", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "新建客户", exact: true }).click();
        await page.getByLabel("公司名称", { exact: true }).fill("新建的客户");
        await page.locator('form button[type="submit"]').click();
      }
      await expect.poll(() => methods.filter(method => method === expectedMethod).length).toBe(1);
      const control = interruption === "read" ? "撤销测试读权限" : "卸载测试页面";
      await page.getByRole("button", { name: control, exact: true }).evaluate(element => (element as HTMLButtonElement).click());
      if (interruption === "read") await page.getByText("当前会话没有客户交付读取权限", { exact: true }).waitFor();
      else await page.getByRole("heading", { name: "客户交付", exact: true }).waitFor({ state: "hidden" });
      const acknowledged = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().postDataJSON().method === expectedMethod);
      releaseMutation!();
      await (await acknowledged).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(methods.filter(method => method === "ops.customer-delivery.list")).toHaveLength(1);
      expect(methods.filter(method => method === expectedMethod)).toHaveLength(1);
      await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
    } finally { releaseMutation?.(); await page.close(); }
  }, 45_000);
});
