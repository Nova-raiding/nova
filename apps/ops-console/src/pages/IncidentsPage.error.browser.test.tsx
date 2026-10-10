import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("IncidentsPage list recovery and filters", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-incidents-page-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-incidents-${randomUUID()}`;
    const harnessHtml = join(opsRoot, `${harnessName}.html`);
    const harnessEntry = join(opsRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(harnessEntry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from 'antd';
      import { IncidentsPage } from '/src/pages/IncidentsPage.tsx';
      window.__incidentListCalls = [];
      window.__incidentDetailReads = 0;
      window.__incidentMutationCalls = 0;
      window.__incidentCreateCalls = 0;
      window.__rejectNextIncidentComment = undefined;
      const createJourney = new URLSearchParams(location.search).get('create') === '1';
      const appendJourney = new URLSearchParams(location.search).get('append') === '1';
      const switchJourney = new URLSearchParams(location.search).get('switch') === '1';
      const partialJourney = new URLSearchParams(location.search).get('partial-reconciliation') === '1';
      const createReadFailJourney = new URLSearchParams(location.search).get('create-read-fail') === '1';
      const filterFailedTargetOut = new URLSearchParams(location.search).get('filter-target-out') === '1';
      let failTimelineAfterMutation = partialJourney;
      const incident = { id: 'inc-1', workspaceId: 'ws-a', title: 'API 请求失败', summary: '商家 API 请求持续失败', severity: 'sev2', status: 'investigating', affectedComponents: ['api'], affectedWorkspaceIds: ['ws-a'], revision: 1, createdBy: 'ops', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' };
      const secondIncident = { ...incident, id: 'inc-2', title: 'Worker 队列积压' };
      const client = {
        list: async input => {
          window.__incidentListCalls.push({ status: input.status, severity: input.severity, ...(input.cursor ? { cursor: input.cursor } : {}) });
          if (appendJourney) {
            if (window.__incidentListCalls.length === 1) return { items: [incident], nextCursor: 'cursor-1' };
            if (window.__incidentListCalls.length === 2) throw new Error('下一页读取失败');
            return { items: [secondIncident] };
          }
          if (createReadFailJourney && window.__incidentListCalls.length === 2) throw new Error('创建后列表读取失败');
          if (!createJourney && window.__incidentListCalls.length === 1) throw new Error('读取事故列表失败');
          if (filterFailedTargetOut && input.status === 'resolved') return { items: [] };
          return { items: createJourney ? [] : switchJourney ? [incident, secondIncident] : [incident] };
        },
        get: async id => { window.__incidentDetailReads += 1; return id === 'inc-2' ? secondIncident : partialJourney && window.__incidentMutationCalls > 0 ? { ...incident, revision: 2 } : incident; },
        timeline: async () => {
          if (partialJourney && window.__incidentMutationCalls > 0 && failTimelineAfterMutation) {
            failTimelineAfterMutation = false;
            throw new Error('时间线暂时不可用');
          }
          return { items: partialJourney && window.__incidentMutationCalls > 0 ? [{ id: 'event-2', workspaceId: 'ws-a', incidentId: 'inc-1', kind: 'comment', body: '核对接口故障影响范围', actorId: 'ops', incidentRevision: 2, createdAt: '2026-10-10T00:01:00.000Z' }] : [] };
        },
        create: async () => { window.__incidentCreateCalls += 1; window.__incidentMutationCalls += 1; throw new Error('创建请求超时'); },
        comment: async () => {
          window.__incidentMutationCalls += 1;
          if (!switchJourney) throw new Error('评论请求超时');
          await new Promise((_, reject) => { window.__rejectNextIncidentComment = () => reject(new Error('评论请求超时')); });
        },
        transition: async () => { throw new Error('unused'); },
        assignCommander: async () => { throw new Error('unused'); },
        updateScope: async () => { throw new Error('unused'); },
      };
      const authorization = { scope: { kind: 'platform' }, canAny: () => true };
      createRoot(document.getElementById('root')).render(React.createElement(App, null, React.createElement(IncidentsPage, { client, authorization })));
    `, { flag: "wx" });
    vite = await createServer({
      configFile: false,
      root: opsRoot,
      cacheDir: join(cacheDirectory, ".vite-cache"),
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Incidents page test listener did not bind");
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

  it("keeps initial list failure to one recovery action, then applies and clears filters", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByText("事故列表不可用").waitFor();
      await page.getByText("读取事故列表失败").waitFor();
      expect(await page.getByRole("button", { name: "重试", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "重试事故列表" }).count()).toBe(1);

      await page.getByRole("button", { name: "重试事故列表" }).click();
      await page.getByText("API 请求失败").waitFor();
      const statusFilter = page.getByRole("combobox", { name: "按状态筛选" });
      await statusFilter.focus();
      await statusFilter.press("ArrowDown");
      await statusFilter.press("Enter");
      await page.getByRole("button", { name: "应用筛选" }).click();
      await page.waitForFunction(() => window.__incidentListCalls.length === 3);
      expect(await page.evaluate(() => window.__incidentListCalls[2])).toEqual({ status: "investigating", severity: undefined });

      await page.getByRole("button", { name: "清除筛选" }).click();
      await page.waitForFunction(() => window.__incidentListCalls.length === 4);
      expect(await page.evaluate(() => window.__incidentListCalls[3])).toEqual({ status: undefined, severity: undefined });
    } finally { await page.close(); }
  }, 60_000);

  it("rechecks the selected incident after an uncertain mutation instead of replaying it", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("button", { name: "重试事故列表" }).click();
      await page.getByRole("button", { name: "查看事故：API 请求失败" }).click();
      await page.getByRole("textbox", { name: "事故评论" }).fill("核对接口故障影响范围");
      await page.getByRole("button", { name: "追加评论" }).click();
      await page.getByRole("region", { name: "事故详情内容" }).locator(".ant-alert-error").filter({ hasText: "评论请求超时" }).waitFor();
      await page.getByText("操作结果尚未确认，系统不会自动重放").waitFor();

      const readsBeforeRecovery = await page.evaluate(() => window.__incidentDetailReads);
      await page.keyboard.press("Escape");
      await page.locator(".ant-drawer-content-wrapper").waitFor({ state: "hidden" });
      await page.locator(".ant-drawer-content-wrapper").waitFor({ state: "hidden" });
      const pageError = page.getByRole("alert").filter({ hasText: "评论请求超时" });
      await pageError.getByText("事故操作结果尚未确认").waitFor();
      await pageError.getByText("创建结果尚未确认").waitFor({ state: "hidden" });
      await pageError.getByRole("button", { name: "重新核对失败目标：API 请求失败" }).click();
      await page.getByText("事故详情已验证。", { exact: true }).waitFor();
      expect(await page.evaluate(() => window.__incidentDetailReads)).toBe(readsBeforeRecovery + 1);
      expect(await page.evaluate(() => window.__incidentMutationCalls)).toBe(1);
      expect(await page.getByRole("button", { name: "追加评论" }).count()).toBe(1);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps detail writes locked when detail reload succeeds but timeline reload fails", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?partial-reconciliation=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("button", { name: "重试事故列表" }).click();
      await page.getByRole("button", { name: "查看事故：API 请求失败" }).click();
      await page.getByRole("textbox", { name: "事故评论" }).fill("核对接口故障影响范围");
      await page.getByRole("button", { name: "追加评论" }).click();
      await page.getByRole("button", { name: "重新核对所选事故" }).click();
      await page.getByText("事故操作结果仍待核对", { exact: false }).waitFor();
      expect(await page.getByRole("button", { name: "追加评论" }).count()).toBe(0);
      expect(await page.getByText("事故操作结果仍待核对：“API 请求失败”（inc-1）。完成目标事故详情和时间线核对前，所有事故详情写操作保持锁定。", { exact: true }).count()).toBe(1);
      expect(await page.evaluate(() => window.__incidentMutationCalls)).toBe(1);

      await page.getByRole("button", { name: "重新核对所选事故" }).click();
      await page.locator(".ant-timeline-item-content").getByText("核对接口故障影响范围", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "追加评论" }).isDisabled()).toBe(false);
      expect(await page.evaluate(() => window.__incidentMutationCalls)).toBe(1);
    } finally { await page.close(); }
  }, 60_000);

  it("does not retry a failed mutation against a different selected incident", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?switch=1&filter-target-out=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("button", { name: "重试事故列表" }).click();
      await page.getByRole("button", { name: "查看事故：API 请求失败" }).click();
      await page.getByRole("textbox", { name: "事故评论" }).fill("核对接口故障影响范围");
      await page.getByRole("button", { name: "追加评论" }).click();
      await page.waitForFunction(() => typeof window.__rejectNextIncidentComment === "function");
      await page.locator(".ant-drawer-close").click();
      await page.locator(".ant-drawer-content-wrapper").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "查看事故：Worker 队列积压" }).click();
      await page.waitForFunction(() => window.__incidentDetailReads >= 2);
      await page.waitForFunction(() => document.querySelector(".ant-drawer-title")?.textContent?.trim() === "事故详情 · Worker 队列积压");
      const detail = page.getByRole("region", { name: "事故详情内容" });
      expect(await detail.getAttribute("aria-busy")).toBe("false");
      await detail.getByRole("textbox", { name: "事故评论" }).fill("Worker 队列确认评论");
      expect(await detail.getByRole("button", { name: "追加评论" }).isDisabled()).toBe(true);
      expect(await page.evaluate(() => window.__incidentMutationCalls)).toBe(1);
      const commentForm = detail.locator("form").filter({ has: detail.getByRole("textbox", { name: "事故评论" }) });
      expect(await commentForm.count()).toBe(1);
      await commentForm.evaluate((form) => form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })));
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate(() => window.__incidentMutationCalls)).toBe(1);
      await page.evaluate(() => window.__rejectNextIncidentComment?.());
      const alert = page.getByRole("alert").filter({ hasText: "评论请求超时" });
      await alert.getByText("事故操作结果尚未确认").waitFor();
      await alert.getByText("失败操作对应的事故").waitFor();
      expect(await alert.locator(".ant-alert-description").innerText()).toContain("API 请求失败");
      expect(await alert.getByText("创建结果尚未确认").count()).toBe(0);
      expect(await alert.getByRole("button", { name: "重新核对失败目标：API 请求失败" }).count()).toBe(1);
      const commentButton = detail.getByRole("button", { name: "追加评论" });
      expect(await commentButton.isDisabled()).toBe(true);
      await page.getByText("事故操作结果仍待核对：“API 请求失败”（inc-1）", { exact: false }).waitFor();

      const detailReadsBeforeRecovery = await page.evaluate(() => window.__incidentDetailReads);
      await page.locator(".ant-drawer-close").click();
      await page.locator(".ant-drawer-content-wrapper").waitFor({ state: "hidden" });
      const statusFilter = page.getByRole("combobox", { name: "按状态筛选" });
      const listCallsBeforeFilter = await page.evaluate(() => window.__incidentListCalls.length);
      await statusFilter.focus();
      await statusFilter.click();
      await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "已解决" }).click();
      await page.getByRole("button", { name: "应用筛选" }).click();
      await page.waitForFunction(count => window.__incidentListCalls.length > count, listCallsBeforeFilter);
      expect(await page.evaluate(() => window.__incidentListCalls.at(-1)?.status)).toBe("resolved");
      await alert.getByRole("button", { name: "重新核对失败目标：API 请求失败" }).click();
      await page.waitForFunction(count => window.__incidentDetailReads === count + 1, detailReadsBeforeRecovery);
      await page.getByText("事故详情已验证。", { exact: true }).waitFor();
      expect(await commentButton.isDisabled()).toBe(false);
      expect(await page.evaluate(() => window.__incidentMutationCalls)).toBe(1);
    } finally { await page.close(); }
  }, 60_000);

  it("locks create immediately while a detail write result is pending", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?switch=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("button", { name: "重试事故列表" }).click();
      await page.getByRole("button", { name: "查看事故：API 请求失败" }).click();
      await page.getByRole("textbox", { name: "事故评论" }).fill("核对接口故障影响范围");
      await page.getByRole("button", { name: "追加评论" }).click();
      await page.waitForFunction(() => typeof window.__rejectNextIncidentComment === "function");
      expect(await page.getByRole("button", { name: "创建事故", exact: true }).isDisabled()).toBe(true);

      await page.evaluate(() => window.__rejectNextIncidentComment?.());
      await page.getByRole("alert").filter({ hasText: "评论请求超时" }).waitFor();
      expect(await page.getByRole("button", { name: "创建事故", exact: true }).isDisabled()).toBe(true);
      expect(await page.evaluate(() => window.__incidentCreateCalls)).toBe(0);

      await page.getByRole("alert").filter({ hasText: "评论请求超时" }).getByRole("button", { name: "重新核对所选事故" }).click();
      await page.getByText("事故详情已验证。", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "创建事故", exact: true }).isDisabled()).toBe(false);
      expect(await page.evaluate(() => window.__incidentCreateCalls)).toBe(0);
      expect(await page.evaluate(() => window.__incidentMutationCalls)).toBe(1);
    } finally { await page.close(); }
  }, 60_000);

  it("does not label an uncertain create failure as a list outage or retry the create", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?create=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("button", { name: "创建事故", exact: true }).click();
      const dialog = page.locator(".ant-modal").filter({ hasText: "创建事故" });
      await dialog.waitFor({ state: "visible" });
      await dialog.locator("input").first().fill("API 服务持续不可用");
      await dialog.locator("textarea").first().fill("商家请求连续失败，需要核对服务恢复状态。");
      const severity = dialog.getByRole("combobox").first();
      await severity.focus();
      await severity.press("ArrowDown");
      await severity.press("Enter");
      await dialog.getByRole("button", { name: "创建事故", exact: true }).click();

      await page.getByRole("alert").filter({ hasText: "创建请求超时" }).waitFor();
      await page.getByText("创建结果尚未确认，系统不会自动重放").waitFor();
      expect(await page.getByText("事故列表不可用").count()).toBe(0);
      await dialog.getByRole("status").getByRole("button", { name: "重新读取事故列表" }).click();
      await page.waitForFunction(() => window.__incidentListCalls.length === 2);
      expect(await page.evaluate(() => window.__incidentMutationCalls)).toBe(1);
      await dialog.waitFor({ state: "visible" });
      await dialog.getByRole("button", { name: "我已核对列表，解除创建锁" }).waitFor({ state: "visible" });
      expect(await dialog.locator(".ant-modal-footer .ant-btn-primary").isDisabled()).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "创建事故", exact: true }).waitFor({ state: "visible" });
      expect(await page.getByRole("button", { name: "创建事故", exact: true }).isDisabled()).toBe(true);
      const pageRecovery = page.getByRole("status").filter({ hasText: "事故写操作结果待核对" });
      await pageRecovery.getByRole("button", { name: "我已核对列表，解除创建锁" }).waitFor({ state: "visible" });
      expect(await pageRecovery.getByRole("button", { name: "我已核对列表，解除创建锁" }).isDisabled()).toBe(false);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps a follow-up list read failure and retry visible inside the create dialog", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?create=1&create-read-fail=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("button", { name: "创建事故", exact: true }).click();
      const dialog = page.locator(".ant-modal").filter({ hasText: "创建事故" });
      await dialog.locator("input").first().fill("API 服务持续不可用");
      await dialog.locator("textarea").first().fill("商家请求连续失败，需要核对服务恢复状态。");
      const severity = dialog.getByRole("combobox").first();
      await severity.focus();
      await severity.press("ArrowDown");
      await severity.press("Enter");
      await dialog.getByRole("button", { name: "创建事故", exact: true }).click();
      await dialog.getByRole("status").getByRole("button", { name: "重新读取事故列表" }).click();
      await dialog.getByRole("alert").getByText("事故列表读取失败").waitFor();
      await dialog.locator(".ant-alert-error button").click();
      await dialog.getByText("上一次事故创建结果仍待核对", { exact: false }).waitFor();
      await dialog.getByRole("alert").getByText("事故列表读取失败").waitFor({ state: "hidden" });
      expect(await dialog.getByRole("alert").getByText("事故列表读取失败").count()).toBe(0);
      expect(await page.evaluate(() => window.__incidentMutationCalls)).toBe(1);
    } finally { await page.close(); }
  }, 60_000);

  it("retries a failed next page with its cursor and preserves the existing incident rows", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html?append=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByText("API 请求失败").waitFor();
      await page.getByRole("button", { name: "加载更多事故" }).click();
      await page.getByRole("alert").filter({ hasText: "下一页读取失败" }).waitFor();
      const retryAppend = page.getByRole("button", { name: "重试加载更多事故" });
      await retryAppend.click();
      await page.getByText("Worker 队列积压").waitFor();
      expect(await page.getByText("API 请求失败").count()).toBe(1);
      expect(await page.evaluate(() => window.__incidentListCalls.map(call => call.cursor))).toEqual([undefined, "cursor-1", "cursor-1"]);
    } finally { await page.close(); }
  }, 60_000);
});

declare global {
  interface Window {
    __incidentListCalls: Array<{ status?: string; severity?: string; cursor?: string }>;
    __incidentDetailReads: number;
    __incidentMutationCalls: number;
    __incidentCreateCalls: number;
    __rejectNextIncidentComment?: () => void;
  }
}
