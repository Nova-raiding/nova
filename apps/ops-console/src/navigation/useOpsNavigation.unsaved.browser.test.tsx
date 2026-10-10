import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("Ops navigation unsaved changes guard", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-unsaved-navigation-"));
    const opsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-unsaved-${randomUUID()}`;
    const harnessHtml = join(opsRoot, `${harnessName}.html`);
    const harnessEntry = join(opsRoot, `${harnessName}.tsx`);
    harnessFiles = [harnessHtml, harnessEntry];
    await writeFile(harnessHtml, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, "", "/ops/overview")</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(harnessEntry, `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Modal } from 'antd';
      import { OpsSidebar } from '/src/components/OpsSidebar.tsx';
      import { UnsavedChangesProvider, useUnsavedChanges, useUnsavedChangesState } from '/src/components/authz/UnsavedChangesContext.tsx';
      import { useOpsNavigation } from '/src/navigation/useOpsNavigation.ts';
      function Probe() {
        const state = useUnsavedChangesState();
        const navigation = useOpsNavigation({ beforeNavigate: (transition) => state.requestTransition(transition) });
        const [dirty, setDirty] = useState(false);
        useEffect(() => setDirty(false), [navigation.activeDomain]);
        useUnsavedChanges(dirty, '任务编辑表单');
        return React.createElement(React.Fragment, null,
          React.createElement(OpsSidebar, { activeDomain: navigation.activeDomain, visibleDomains: ['overview', 'finance'], onNavigate: navigation.navigate }),
          React.createElement('button', { onClick: () => setDirty(true) }, '编辑任务草稿'),
          React.createElement('button', { onClick: () => navigation.navigateWithQuery('finance', { accountId: 'acct-42' }) }, '打开指定账户'),
          React.createElement('main', { id: 'ops-main-content', tabIndex: -1 }, navigation.activeDomain),
          React.createElement(Modal, { open: Boolean(state.pendingTransition), title: '放弃未保存内容并离开？', okText: '放弃并继续', cancelText: '继续编辑', onOk: state.confirmTransition, onCancel: state.cancelTransition }, state.pendingTransition?.labels.join('、'))
        );
      }
      createRoot(document.getElementById('root')).render(React.createElement(UnsavedChangesProvider, null, React.createElement(Probe)));
    `, { flag: "wx" });
    vite = await createServer({ configFile: false, root: opsRoot, cacheDir: join(cacheDirectory, ".vite-cache"), logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false } });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Ops unsaved navigation listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 120_000);

  afterAll(async () => {
    try { await browser?.close(); } finally {
      try { await vite?.close(); } finally {
        try { await Promise.all(harnessFiles.map((file) => rm(file, { force: true }))); }
        finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
      }
    }
  }, 60_000);

  it("guards sidebar and query navigation, preserving draft on cancel and committing on confirmation", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/${harnessName}.html`);
      await expectDomain(page, "overview");
      const finance = page.getByRole("button", { name: "账务与退款" });
      await page.getByRole("button", { name: "编辑任务草稿" }).click();
      await finance.click();
      await expect.poll(() => page.getByRole("dialog").innerText()).toContain("任务编辑表单");
      expect(new URL(page.url()).pathname).toBe("/ops/overview");
      await page.getByRole("button", { name: "继续编辑" }).click();
      await expectDomain(page, "overview");
      expect(new URL(page.url()).pathname).toBe("/ops/overview");
      await expect.poll(() => finance.evaluate((element) => element === document.activeElement)).toBe(true);

      await finance.click();
      await page.getByRole("button", { name: "放弃并继续" }).click();
      await expectDomain(page, "finance");
      expect(new URL(page.url()).pathname).toBe("/ops/finance");

      await page.goBack();
      await expectDomain(page, "overview");
      await page.getByRole("button", { name: "编辑任务草稿" }).click();
      await page.getByRole("button", { name: "打开指定账户", exact: true }).click();
      await expect.poll(() => page.getByRole("dialog").innerText()).toContain("任务编辑表单");
      await page.getByRole("button", { name: "继续编辑" }).click();
      expect(new URL(page.url()).pathname).toBe("/ops/overview");
      await page.getByRole("button", { name: "打开指定账户", exact: true }).click();
      await expect.poll(() => page.getByRole("dialog").innerText()).toContain("任务编辑表单");
      await page.getByRole("button", { name: "放弃并继续" }).click();
      await expectDomain(page, "finance");
      expect(new URL(page.url()).searchParams.get("accountId")).toBe("acct-42");
    } finally { await page.close(); }
  }, 60_000);

  it("restores Back and Forward entries after cancellation without reopening the prompt", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(`${baseUrl}/${harnessName}.html`);
      const finance = page.getByRole("button", { name: "账务与退款" });
      await finance.click();
      await expectDomain(page, "finance");
      await page.goBack();
      await expectDomain(page, "overview");
      await page.getByRole("button", { name: "编辑任务草稿" }).click();
      await page.goForward();
      await expect.poll(() => page.getByRole("dialog").innerText()).toContain("任务编辑表单");
      await page.getByRole("button", { name: "继续编辑" }).click();
      await expectDomain(page, "overview");
      expect(new URL(page.url()).pathname).toBe("/ops/overview");
      await page.goForward();
      await expect.poll(() => page.getByRole("dialog").innerText()).toContain("任务编辑表单");
      await page.getByRole("button", { name: "放弃并继续" }).click();
      await expectDomain(page, "finance");
      expect(new URL(page.url()).pathname).toBe("/ops/finance");
    } finally { await page.close(); }
  }, 60_000);
});

async function expectDomain(page: import("playwright").Page, domain: string) {
  await expect.poll(() => page.locator("#ops-main-content").textContent()).toBe(domain);
}
