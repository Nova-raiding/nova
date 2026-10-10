import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

/**
 * Workspace TasksPage journey. OpsConsoleController intentionally cannot
 * activate a workspace workbench, so this local fixture mounts the real page
 * with the same workspace capability projection and session shape. It proves
 * page/filter/result behavior without claiming the controller route is live.
 */
describe("TasksPage workspace filters browser journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-tasks-workspace-filters-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-tasks-filters-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${harnessName}.tsx"></script></body></html>`,
      { flag: "wx" },
    );
    await writeFile(entryPath, `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from 'antd';
      import { TasksPage } from '/src/pages/TasksPage.tsx';
      import { marketingQueueParams } from '/src/hooks/useOpsConsoleModel.ts';

      const allRows = [
        { id: 'g-failed', taskId: 'task-failed', state: 'failed', attempt: 2, revision: 1, updatedAt: '2026-10-11T08:00:00.000Z', platform: 'jd', accountId: 'acct-jd-1', productId: 'product-1' },
        { id: 'g-queued', taskId: 'task-queued', state: 'queued', attempt: 0, revision: 1, updatedAt: '2026-10-11T08:01:00.000Z', platform: 'jd', accountId: 'acct-jd-1', productId: 'product-2' },
      ];
      const emptyQueue = { videoProviderJobs: [], generation: [], publish: [], visuals: [], batches: [], learningSuggestions: [], assetRisks: [], uploadedAssetRisks: [], imageExecutions: [] };
      function Fixture() {
        const [queueFilters, setQueueFilters] = useState({});
        const [marketingQueue, setMarketingQueue] = useState(emptyQueue);
        const [marketingQueueLoadedAt, setMarketingQueueLoadedAt] = useState(undefined);
        const [rpcCalls, setRpcCalls] = useState([]);
        const model = {
          authorization: {
            scope: { kind: 'workspace', id: 'ws-fixture' },
            can: capability => ['marketing.queue.read', 'customer.content.read'].includes(capability),
            canAny: capabilities => capabilities.some(capability => ['marketing.queue.read', 'customer.content.read'].includes(capability)),
          },
          opsSession: { actor_id: 'fixture-operator', workspace_id: 'ws-fixture', workbench: 'workspace', scope: { type: 'workspace', id: 'ws-fixture' }, capabilities: ['marketing.queue.read', 'customer.content.read'] },
          opsWorkspaceId: 'ws-fixture',
          loading: false,
          dataSetError: () => undefined,
          queueFilters,
          setQueueFilters,
          alertFilters: {}, setAlertFilters: () => {},
          storeDirectory: [{ workspaceId: 'ws-fixture', platform: 'jd', accountId: 'acct-jd-1', label: '京东旗舰店' }],
          canQueue: true,
          marketingQueue,
          marketingQueueLoadedAt,
          load: async (overrides = {}) => {
            const filters = overrides.queueFilters ?? queueFilters;
            const params = marketingQueueParams(filters);
            setRpcCalls(previous => [...previous, { method: 'ops.marketing.queue', params }]);
            const matched = allRows.filter(row =>
              (!filters.platform || row.platform === filters.platform)
              && (!filters.accountId || row.accountId === filters.accountId)
              && (!filters.productId || row.productId === filters.productId)
              && (!filters.taskId || row.taskId === filters.taskId)
              && (!filters.state || row.state === filters.state));
            setMarketingQueue({ ...emptyQueue, generation: matched });
            setMarketingQueueLoadedAt(new Date('2026-10-11T08:05:00.000Z'));
          },
          retryGeneration: async () => false,
          acknowledgePublish: async () => false,
          assignQueueItem: async () => false,
          createRevision: async () => false,
          pausePublishBatch: async () => false,
          resumePublishBatch: async () => false,
          retryFailedPublishBatch: async () => false,
          reviewVisual: async () => false,
          reconcileImageExecution: async () => false,
          recordManualPublishEvidence: async () => false,
          supportClient: { create: async () => undefined },
        };
        window.__tasksFixture = { get rpcCalls() { return rpcCalls; }, get queueFilters() { return queueFilters; } };
        return <App><TasksPage model={model} /></App>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `, { flag: "wx" });

    vite = await createServer({
      configFile: false,
      root: appRoot,
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "ops-tasks-workspace-fixture",
        resolveId(id) {
          if (id === "../components/stores/ProductSpreadsheetImport.js") return "\0tasks-fixture-product-import";
          if (id === "./DeliveryGovernancePanel") return "\0tasks-fixture-delivery";
          if (id === "./ImageAuditPanel") return "\0tasks-fixture-image-audit";
          if (id === "./UploadedAssetGovernance") return "\0tasks-fixture-uploaded-assets";
          if (id === "./CampaignLifecycleControl.js" || id === "./CampaignLifecycleControl") return "\0tasks-fixture-campaign";
          if (id === "./ImageExecutionEvidenceModal.js" || id === "./ImageExecutionEvidenceModal") return "\0tasks-fixture-image-modal";
        },
        load(id) {
          if (id === "\0tasks-fixture-product-import") return "export function ProductSpreadsheetImport(){return null}";
          if (id === "\0tasks-fixture-delivery") return "export function DeliveryGovernancePanel(){return null}";
          if (id === "\0tasks-fixture-image-audit") return "export function ImageAuditPanel(){return null}";
          if (id === "\0tasks-fixture-uploaded-assets") return "export function UploadedAssetGovernance(){return null}";
          if (id === "\0tasks-fixture-campaign") return "export function CampaignLifecycleControl(){return null}";
          if (id === "\0tasks-fixture-image-modal") return "export function ImageExecutionEvidenceModal(){return null}";
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url === "/favicon.ico") {
              response.statusCode = 204;
              response.end();
              return;
            }
            next();
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("TasksPage fixture listener did not bind");
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

  it("edits workspace filters, applies RPC params, reads the matching row, then clears and reads the full queue", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(15_000);
    const browserErrors: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
    try {
      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "任务与内容" }).waitFor({ state: "visible" });
      await page.getByRole("heading", { name: "待处理队列" }).waitFor({ state: "visible" });
      await page.getByText("任务与素材治理", { exact: true }).waitFor({ state: "visible" });

      await page.getByRole("combobox", { name: "按营销队列平台筛选" }).click();
      await page.getByText("京东", { exact: true }).last().click();
      await page.getByRole("combobox", { name: "按营销队列店铺筛选" }).click();
      await page.getByText("京东旗舰店 · 京东", { exact: true }).click();
      await page.getByRole("textbox", { name: "按营销队列商品 ID 筛选" }).fill("product-1");
      await page.getByRole("textbox", { name: "按营销队列任务 ID 筛选" }).fill("task-failed");
      await page.getByRole("combobox", { name: "按营销队列状态筛选" }).click();
      await page.getByText("失败", { exact: true }).last().click();

      await page.getByRole("button", { name: "应用筛选" }).click();
      await page.getByText("task-failed", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("任务队列（1）", { exact: true }).waitFor({ state: "visible" });
      const firstRead = await page.evaluate(() => (window as any).__tasksFixture.rpcCalls[0]);
      expect(firstRead).toEqual({
        method: "ops.marketing.queue",
        params: { limit: "20", platform: "jd", account_id: "acct-jd-1", product_id: "product-1", task_id: "task-failed", state: "failed" },
      });
      expect(await page.getByText("task-queued", { exact: true }).count()).toBe(0);

      await page.getByRole("button", { name: "清除筛选" }).click();
      await page.getByText("task-queued", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("任务队列（2）", { exact: true }).waitFor({ state: "visible" });
      const cleared = await page.evaluate(() => ({
        filters: (window as any).__tasksFixture.queueFilters,
        calls: (window as any).__tasksFixture.rpcCalls,
      }));
      expect(cleared.filters).toEqual({});
      expect(cleared.calls).toHaveLength(2);
      expect(cleared.calls[1]).toEqual({ method: "ops.marketing.queue", params: { limit: "20" } });
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

declare global {
  interface Window {
    __tasksFixture: { readonly rpcCalls: Array<{ method: string; params: Record<string, string> }>; readonly queueFilters: Record<string, string> };
  }
}
