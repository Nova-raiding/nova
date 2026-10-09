import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("support mutation refresh failure", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-ticket-selection-"));
    const entryPath = "/__support-ticket-selection-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "support-ticket-selection-regression",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id: string) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { useSupportDomain } from '/src/hooks/useSupportDomain.ts';
            import { SupportTicketDetailSection } from '/src/components/support/SupportTicketDetailSection.tsx';
            let ticket = { id: 'ticket-good', workspaceId: 'ws_test', ticketNumber: 'SUP-1', subject: '已选工单', description: '问题', status: 'open', priority: 'normal', customerId: 'c1', customerName: '商户', tags: [], revision: 1, createdBy: 'ops', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
            let events = [{ id: 'event-created', workspaceId: 'ws_test', ticketId: 'ticket-good', sequence: 1, eventType: 'created', actorId: 'ops', idempotencyKey: 'create-0001', payload: { status: 'open' }, createdAt: '2026-10-01T00:00:00.000Z' }];
            let failNextDetailRefresh = false;
            let failCorrectionOnce = true;
            const correctionKeys = [];
            let failDecisionOnce = true;
            const decisionKeys = [];
            window.__supportCorrectionKeys = correctionKeys;
            window.__supportDecisionKeys = decisionKeys;
            function Harness() {
              const client = {
                async list() { return { items: [ticket] }; },
                async get(_workspaceId, id) {
                  if (id === 'ticket-broken') throw new Error('工单详情读取失败');
                  if (failNextDetailRefresh) { failNextDetailRefresh = false; throw new Error('详情回读网络失败'); }
                  return { ticket, events };
                },
                async create() {},
                async assign(command) {
                  ticket = { ...ticket, assignedTo: command.assigneeId, revision: ticket.revision + 1 };
                  const event = { id: 'event-assigned', workspaceId: 'ws_test', ticketId: ticket.id, sequence: 2, eventType: 'assigned', actorId: 'ops', idempotencyKey: command.idempotencyKey, payload: { assigneeId: command.assigneeId }, createdAt: new Date().toISOString() };
                  events = [...events, event];
                  failNextDetailRefresh = true;
                  return { ticket, event, replayed: false };
                },
                async transition() {}, async comment() {},
                async report() { return { reportId: 'report-current', workspaceId: 'ws_test', periodStart: '2026-09-01', periodEnd: '2026-09-30', cutoffAt: '2026-10-01T00:00:00.000Z', policyVersions: [], calendarVersions: [], denominator: 0, met: 0, failed: 0, excluded: 0, lateOrUnresolved: 0, checksum: 'checksum', ticketResults: [] }; },
                async createCorrection(input) {
                  correctionKeys.push(input.idempotencyKey);
                  if (failCorrectionOnce && input.reason !== '审批测试') { failCorrectionOnce = false; throw new Error('correction 响应丢失'); }
                  if (input.reason === '审批测试') return { correctionId: 'correction-pending', originalReportId: input.originalReportId, status: 'pending_review' };
                  return { status: 'no_change', originalReportId: input.originalReportId, checksum: 'checksum' };
                }, async decideCorrection(input) {
                  decisionKeys.push(input.idempotencyKey);
                  if (failDecisionOnce) { failDecisionOnce = false; await new Promise(resolve => setTimeout(resolve, 75)); throw new Error('审批响应丢失'); }
                  return { correctionId: input.correctionId, decision: input.decision, state: 'completed' };
                },
              };
              const model = useSupportDomain(client, 'ws_test');
              return React.createElement('main', null,
                React.createElement('output', { 'data-testid': 'selection-state' }, JSON.stringify({ selected: model.selected?.ticket.id || null, detailLoading: model.detailLoading, error: model.error })),
                React.createElement('output', { 'data-testid': 'correction-state' }, JSON.stringify({ report: model.report?.reportId || null, correction: model.correction?.status || null, error: model.error })),
                React.createElement('output', { 'data-testid': 'correction-keys' }, correctionKeys.join(',')),
                React.createElement('output', { 'data-testid': 'decision-keys' }, decisionKeys.join(',')),
                React.createElement('button', { onClick: () => void model.loadReport({ periodStart: '2026-09-01', periodEnd: '2026-09-30', cutoffAt: '2026-10-01T00:00:00.000Z' }) }, '读取 SLA 月报'),
                React.createElement('button', { onClick: () => void model.createCorrection?.('修正原因').catch(() => undefined) }, '创建 correction'),
                React.createElement('button', { onClick: () => void model.createCorrection?.('审批测试').catch(() => undefined) }, '创建审批测试 correction'),
                React.createElement('button', { onClick: () => void model.decideCorrection?.('approved', '审批理由', 'approval-token').catch(() => undefined) }, '提交 correction 决策'),
                React.createElement('button', { onClick: () => { void model.loadReport({ periodStart: '2026-09-01', periodEnd: '2026-09-30', cutoffAt: '2026-10-01T00:00:00.000Z' }); void model.createCorrection?.('刷新期间不应创建').catch(() => undefined); } }, '刷新时立即创建 correction'),
                React.createElement('button', { onClick: () => void model.selectTicket('ticket-good') }, '选择正常工单'),
                React.createElement('button', { onClick: () => void model.selectTicket('ticket-broken') }, '选择读取失败工单'),
                React.createElement(SupportTicketDetailSection, { model, canMutate: true }));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__support-ticket-selection-test")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support ticket selection listener did not bind");
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

  it("closes the assign form and keeps the committed ticket visible when only the detail read fails", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/__support-ticket-selection-test`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      page.setDefaultTimeout(5_000);
      await page.getByRole("button", { name: "选择正常工单" }).click();
      await expect.poll(async () => JSON.parse((await page.getByTestId("selection-state").textContent()) || "{}")).toMatchObject({ selected: "ticket-good", detailLoading: false });

      await page.getByRole("button", { name: "分配负责人" }).click();
      await page.getByLabel("负责人 ID").fill("support-owner");
      await page.getByRole("button", { name: "确认分配" }).click();

      await expect.poll(() => page.getByText("工单已保存，详情尚未刷新").isVisible()).toBe(true);
      await expect.poll(() => page.getByRole("button", { name: "重新加载工单详情" }).isVisible()).toBe(true);
      await expect.poll(() => page.getByText("负责人：support-owner").isVisible()).toBe(true);
      await expect.poll(() => page.getByText("版本 2").isVisible()).toBe(true);
      await expect.poll(() => page.getByText("分配负责人 · #2").isVisible()).toBe(true);
      await expect.poll(() => page.getByRole("dialog").count()).toBe(0);

      await page.getByRole("button", { name: "重新加载工单详情" }).click();
      await expect.poll(() => page.getByText("工单已保存，详情尚未刷新").count()).toBe(0);
      await expect.poll(() => page.getByText("负责人：support-owner").isVisible()).toBe(true);
    } finally { await page.close(); }
  }, 60_000);

  it("reuses the correction idempotency key when the same submission is retried after a lost response", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/__support-ticket-selection-test`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      page.setDefaultTimeout(5_000);
      await page.getByRole("button", { name: "读取 SLA 月报" }).click();
      await expect.poll(() => page.getByTestId("correction-state").textContent()).toContain('"report":"report-current"');
      await page.getByRole("button", { name: "创建 correction", exact: true }).click();
      await expect.poll(() => page.getByTestId("correction-state").textContent()).toContain("correction 响应丢失");
      await page.getByRole("button", { name: "创建 correction", exact: true }).click();
      await expect.poll(() => page.getByTestId("correction-state").textContent()).toContain('"correction":"no_change"');
      const keys = (await page.getByTestId("correction-keys").textContent())!.split(",");
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
      expect(keys[1]).toBe(keys[0]);
      await page.getByRole("button", { name: "刷新时立即创建 correction" }).click();
      await expect.poll(() => page.getByTestId("correction-state").textContent()).toContain('"report":"report-current"');
      await expect.poll(() => page.getByTestId("correction-keys").textContent()).toBe(keys.join(","));
    } finally { await page.close(); }
  }, 60_000);

  it("single-flights rapid duplicate decisions and reuses the idempotency key after a lost response", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/__support-ticket-selection-test`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      page.setDefaultTimeout(5_000);
      await page.getByRole("button", { name: "读取 SLA 月报" }).click();
      await expect.poll(() => page.getByTestId("correction-state").textContent()).toContain('"report":"report-current"');
      await page.getByRole("button", { name: "创建审批测试 correction" }).click();
      await expect.poll(() => page.getByTestId("correction-state").textContent()).toContain('"correction":"pending_review"');
      await page.getByRole("button", { name: "提交 correction 决策" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await expect.poll(() => page.getByTestId("correction-state").textContent()).toContain("审批响应丢失");
      const firstKeys = (await page.getByTestId("decision-keys").textContent())!.split(",");
      expect(firstKeys).toHaveLength(1);
      await page.getByRole("button", { name: "提交 correction 决策" }).click();
      await expect.poll(() => page.getByTestId("decision-keys").textContent()).toContain(",");
      const keys = (await page.getByTestId("decision-keys").textContent())!.split(",");
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    } finally { await page.close(); }
  }, 60_000);
});
