import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("support mutation detail navigation race", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "support-mutation-navigation-"));
    const entryPath = "/__support-mutation-navigation-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "support-mutation-navigation-regression",
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
            let getCalls = 0;
            window.__refreshStarted = false;
            window.__resolveRefresh = () => {};
            function Harness() {
              const client = {
                async list() { return { items: [ticket] }; },
                async get() {
                  getCalls += 1;
                  if (getCalls > 1) {
                    window.__refreshStarted = true;
                    return await new Promise(resolve => { window.__resolveRefresh = () => resolve({ ticket, events }); });
                  }
                  return { ticket, events };
                },
                async create() {},
                async assign(command) {
                  ticket = { ...ticket, assignedTo: command.assigneeId, revision: ticket.revision + 1 };
                  const event = { id: 'event-assigned', workspaceId: 'ws_test', ticketId: ticket.id, sequence: 2, eventType: 'assigned', actorId: 'ops', idempotencyKey: command.idempotencyKey, payload: { assigneeId: command.assigneeId }, createdAt: new Date().toISOString() };
                  events = [...events, event];
                  return { ticket, event, replayed: false };
                },
                async transition() {}, async comment() {}, async report() {}, async createCorrection() {}, async decideCorrection() {},
              };
              const model = useSupportDomain(client, 'ws_test');
              return React.createElement('main', null,
                React.createElement('output', { 'data-testid': 'selection-state' }, JSON.stringify({ selected: model.selected?.ticket.id || null, detailLoading: model.detailLoading })),
                React.createElement('button', { onClick: () => void model.selectTicket('ticket-good') }, '选择工单'),
                React.createElement(SupportTicketDetailSection, { model, canMutate: true }));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__support-mutation-navigation-test")) return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(output); }).catch(next);
          });
        },
      }],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Support mutation navigation listener did not bind");
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

  it("does not restore a ticket after the operator closes it while a mutation detail read is in flight", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/__support-mutation-navigation-test`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      page.setDefaultTimeout(5_000);
      await page.getByRole("button", { name: "选择工单" }).click();
      await expect.poll(async () => JSON.parse((await page.getByTestId("selection-state").textContent()) || "{}")).toMatchObject({ selected: "ticket-good", detailLoading: false });

      await page.getByRole("button", { name: "分配负责人" }).click();
      await page.getByLabel("负责人 ID").fill("support-owner");
      await page.getByRole("button", { name: "确认分配" }).click();
      await expect.poll(() => page.evaluate(() => window.__refreshStarted)).toBe(true);
      await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
      await page.getByRole("button", { name: "关闭详情" }).click();
      await page.evaluate(() => window.__resolveRefresh());
      await expect.poll(async () => JSON.parse((await page.getByTestId("selection-state").textContent()) || "{}")).toMatchObject({ selected: null });
      await expect.poll(() => page.getByText("从工单队列中选择一项查看完整事件历史").isVisible()).toBe(true);
      await expect.poll(() => page.getByText("SUP-1").count()).toBe(0);
    } finally { await page.close(); }
  }, 60_000);
});

declare global {
  interface Window {
    __refreshStarted: boolean;
    __resolveRefresh: () => void;
  }
}
