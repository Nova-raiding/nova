import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("point adjustment proposal and approval separation", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-point-adjustment-"));
    const entryPath = "/__point-adjustment-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      plugins: [{
        name: "point-adjustment-test",
        resolveId(id: string) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { App } from 'antd';
            import { PointAdjustmentPanel } from '/src/components/commercial/PointAdjustmentPanel.tsx';
            window.__pointAdjustmentCalls = { proposals: [], decisions: [] };
            const controller = {
              targetWorkspaceId: 'ws_fixture',
              permissions: { canAdjustPoints: true, canApprovePoints: true },
              client: {
                proposePointAdjustment: async (workspace, delta, reason) => {
                  window.__pointAdjustmentCalls.proposals.push({ workspace, delta, reason });
                  return { proposal_id: 'proposal_created_by_this_operator' };
                },
                decidePointAdjustment: async (workspace, id, decision, reason) => {
                  window.__pointAdjustmentCalls.decisions.push({ workspace, id, decision, reason });
                },
              },
            };
            createRoot(document.getElementById('root')).render(React.createElement(App, null,
              React.createElement(PointAdjustmentPanel, { controller })));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__point-adjustment-test") return next();
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>`;
            void server.transformIndexHtml(req.url, html).then(output => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(output);
            }).catch(next);
          });
        },
      }],
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Point adjustment fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it("keeps a new proposal out of approval and accepts a separate proposal after the dialog closes", async () => {
    const page = await openFixture();
    try {
      const approvalInput = page.getByLabel("待审批 proposal id");
      await page.getByRole("button", { name: "新建调整提议" }).click();
      await page.getByLabel("点数变更").fill("20");
      await page.getByLabel("调整原因").fill("修复服务延期补偿");
      await page.getByRole("button", { name: "提交提议" }).click();
      await page.getByText("proposal_created_by_this_operator").waitFor({ state: "visible" });
      await page.getByRole("dialog").waitFor({ state: "hidden" });

      await expect.poll(() => approvalInput.inputValue()).toBe("");
      expect(await page.evaluate(() => window.__pointAdjustmentCalls)).toEqual({
        proposals: [{ workspace: "ws_fixture", delta: 20, reason: "修复服务延期补偿" }],
        decisions: [],
      });

      await approvalInput.fill("proposal_from_another_operator");
      await page.getByRole("button", { name: "批准点数调整提议" }).click();
      await expect.poll(() => page.evaluate(() => window.__pointAdjustmentCalls.decisions)).toEqual([{
        workspace: "ws_fixture", id: "proposal_from_another_operator", decision: "approved", reason: "运营台独立审批点数调整提议",
      }]);
      await expect.poll(() => approvalInput.inputValue()).toBe("");
      await page.getByText("proposal_created_by_this_operator").waitFor({ state: "visible" });
    } finally { await page.close(); }
  }, 45_000);

  async function openFixture(): Promise<Page> {
    if (!browser) throw new Error("Chromium did not start");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20_000);
    await page.goto(`${baseUrl}/__point-adjustment-test`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByText("点数调整（双人审批）").waitFor();
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }
});

declare global {
  interface Window {
    __pointAdjustmentCalls: {
      proposals: unknown[];
      decisions: unknown[];
    };
  }
}
