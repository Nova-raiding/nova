import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("ModelsPage controller route recovery journey", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl = "";
  let harnessFiles: string[] = [];
  let harnessName = "";

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-models-controller-route-"));
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    harnessName = `.codex-ops-models-route-${randomUUID()}`;
    const htmlPath = join(appRoot, `${harnessName}.html`);
    const entryPath = join(appRoot, `${harnessName}.tsx`);
    harnessFiles = [htmlPath, entryPath];
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>history.replaceState(null, '', '/ops/models?workbench=platform')</script><script type="module" src="/${harnessName}.tsx"></script></body></html>`, { flag: "wx" });
    await writeFile(entryPath, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { OpsConsoleController } from '/src/pages/OpsConsoleController.tsx';
      localStorage.setItem('ops_connection_config_v1', JSON.stringify({apiBase: '/api', workspaceId: '', workbench: 'platform', token: 'fixture-token', actorId: 'fixture-operator'}));
      createRoot(document.getElementById('root')).render(React.createElement(OpsConsoleController));
    `, { flag: "wx" });
    vite = await createServer({
      configFile: false,
      root: appRoot,
      cacheDir: cacheDirectory,
      logLevel: "error",
      define: {
        "import.meta.env.VITE_API_BASE": JSON.stringify("/api"),
        "import.meta.env.VITE_OPS_LOCAL_SESSION": JSON.stringify("false"),
        "import.meta.env.VITE_OPS_AUTH_MODE": JSON.stringify("local"),
        "import.meta.env.VITE_OPS_BUILD_MODE": JSON.stringify("local"),
      },
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Models controller browser listener did not bind");
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

  it("recovers model status on Overview, then uses browser Back to return to the legacy Models route", async () => {
    const page = await browser!.newPage();
    page.setDefaultTimeout(20_000);
    let modelStatusReads = 0;
    const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const unexpectedRequests: string[] = [];
    const browserErrors: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
    try {
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin) return route.fallback();
        unexpectedRequests.push(url.origin);
        await route.abort();
      });
      await page.route(url => url.origin === new URL(baseUrl).origin && url.pathname === "/api/mcp", async route => {
        const request = route.request();
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try { rpc = request.postDataJSON() as typeof rpc; }
        catch { unexpectedRequests.push("malformed JSON-RPC"); await route.fulfill({ status: 400, body: "bad JSON-RPC" }); return; }
        const method = rpc.method ?? "";
        const params = rpc.params ?? {};
        rpcCalls.push({ method, params });
        if (method === "ops.session") {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            jsonrpc: "2.0", id: rpc.id ?? null, result: {
              actor_id: "fixture-operator", workspace_id: "", roles: ["platform_ops"], workspace_granted: false,
              workbench: "platform", scope: { type: "platform" },
              capabilities: ["platform.summary.read", "model.status.read", "commercial.read"],
            },
          }) });
          return;
        }
        if (method === "platform.model.status") {
          modelStatusReads += 1;
          if (modelStatusReads === 1) {
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
              jsonrpc: "2.0", id: rpc.id ?? null,
              error: { code: -32000, message: "模型状态服务暂时不可用" },
            }) });
            return;
          }
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            jsonrpc: "2.0", id: rpc.id ?? null, result: readyModelStatus,
          }) });
          return;
        }
        if (method === "ops.commercial.model-markup.get") {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
            jsonrpc: "2.0", id: rpc.id ?? null,
            result: { multiplier: 2.5, reason: "base fixture", revision: 7, updatedBy: "fixture", updatedAt: "2026-10-11T08:00:00.000Z" },
          }) });
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: null }) });
      });

      await page.goto(`${baseUrl}/${harnessName}.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "模型计费设置" }).waitFor({ state: "visible" });
      await page.getByText("模型状态读取失败", { exact: false }).waitFor({ state: "visible" });
      expect(modelStatusReads).toBe(1);
      expect(await page.getByRole("button", { name: "保存并生效" }).count()).toBe(0);

      await page.getByRole("button", { name: "查看平台总览" }).click();
      await page.getByText("模型服务诊断", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("平台模型状态读取失败：状态不可用", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "重试加载平台模型状态" }).click();
      await page.getByText("geo-text-v3", { exact: false }).waitFor({ state: "visible" });
      expect(modelStatusReads).toBe(2);

      expect(new URL(page.url()).pathname).toBe("/ops/overview");
      expect(await page.getByRole("button", { name: "模型服务", exact: true }).count()).toBe(0);
      await page.goBack();
      await page.getByRole("heading", { name: "模型计费设置" }).waitFor({ state: "visible" });
      expect(new URL(page.url()).pathname).toBe("/ops/models");
      expect(new URL(page.url()).searchParams.get("workbench")).toBe("platform");
      expect(rpcCalls.filter(call => call.method === "ops.commercial.model-markup.get")).toHaveLength(1);
      expect(rpcCalls.some(call => call.method === "ops.commercial.model-markup.update")).toBe(false);
      expect(unexpectedRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

const readyModelStatus = {
  ownership: "platform",
  user_key_binding: false,
  state: "ready",
  provider_host: "relay.yxsona.com",
  text_model: "geo-text-v3",
  image_model: "geo-image-v2",
  image_edit_model: "geo-image-edit-v2",
  vision_model: "geo-ocr-v1",
  video_model: "geo-video-v1",
  relay: { configured: true, host: "relay.yxsona.com", reasons: [] },
  capabilities: { text_generation: true, image_generation: true, image_editing: true, image_fact_ocr: true, video_rendering: true },
  model_readiness: Object.fromEntries(["text", "image", "image_edit", "ocr", "video"].map(kind => [kind, { ready: true, https: true, reasons: [], endpointHost: "relay.yxsona.com" }])),
  quotas: { rpm: 60, tpm: 60000, daily_cny_limit: "100.00" },
  cost_control_ready: true,
  cost_evidence_ready: true,
  cost_evidence_by_modality: { text: true, image: true, image_edit: true, ocr: true, video: true },
  release_metadata_ready: true,
  release_metadata_missing: [],
  next_actions: [],
};
