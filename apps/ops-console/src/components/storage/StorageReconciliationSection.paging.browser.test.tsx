import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

describe("Storage reconciliation workspace pagination", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "storage-reconciliation-paging-"));
    const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    harnessName = `.codex-storage-paging-${randomUUID()}`;
    const harnessHtml = join(componentRoot, `${harnessName}.html`);
    const harnessEntry = join(componentRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    const summaries = Array.from({ length: 21 }, (_, index) => ({
      workspaceId: `ws-${index + 1}`,
      status: "clean",
      runStatus: "succeeded",
      lastRunAt: "2026-10-10T00:00:00.000Z",
      freshness: "fresh",
    }));
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(harnessEntry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from 'antd';
      import { StorageReconciliationSection } from '/src/components/storage/StorageReconciliationSection.tsx';
      const summaries = ${JSON.stringify(summaries)};
      createRoot(document.getElementById('root')).render(React.createElement(App, null,
        React.createElement(StorageReconciliationSection, { summaries })
      ));
    `, { flag: "wx" });
    vite = await createServer({
      configFile: false,
      root: componentRoot,
      cacheDir: join(cacheDirectory, ".vite-cache"),
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [react()],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Storage paging fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close().catch(() => undefined); }
    finally {
      try { await vite?.close(); }
      finally {
        try { await Promise.all(harnessFiles.map(file => rm(file, { force: true }))); }
        finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
      }
    }
  }, 60_000);

  it("shows twenty workspaces per page and restores the first page", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      const disclosure = page.getByText("workspace 对账列表（21）", { exact: true });
      await disclosure.waitFor({ state: "visible" });
      await disclosure.click();

      const workspaceList = page.getByRole("list", { name: "workspace 存储对账状态" });
      expect(await workspaceList.getByRole("listitem").count()).toBe(20);
      let workspaceText = await workspaceList.innerText();
      expect(workspaceText).toContain("ws-1");
      expect(workspaceText).toContain("ws-20");
      expect(workspaceText).not.toContain("ws-21");

      const pagination = page.locator(".ant-pagination");
      await pagination.getByText("2", { exact: true }).click();
      expect(await workspaceList.getByRole("listitem").count()).toBe(1);
      workspaceText = await workspaceList.innerText();
      expect(workspaceText).toContain("ws-21");
      expect(workspaceText).not.toContain("ws-20");

      await pagination.getByText("1", { exact: true }).click();
      expect(await workspaceList.getByRole("listitem").count()).toBe(20);
      workspaceText = await workspaceList.innerText();
      expect(workspaceText).toContain("ws-1");
      expect(workspaceText).toContain("ws-20");
      expect(workspaceText).not.toContain("ws-21");
    } finally { await page.close(); }
  }, 30_000);
});
