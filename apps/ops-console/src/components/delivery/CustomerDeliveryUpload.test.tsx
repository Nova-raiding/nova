import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_DELIVERY_MAX_FILE_BYTES,
  customerDeliveryClient,
  parseCustomerDeliveryAsset,
  readCustomerDeliveryFile,
  validateCustomerDeliveryFile,
  type CustomerDeliveryAsset,
} from "../../api/customerDeliveryClient.js";
import { rpc } from "../../api/opsClient.js";
import { CustomerDeliveryUpload, runCustomerDeliveryUploadBatch, waitForDeliveryScan, type DeliveryUploadItem } from "./CustomerDeliveryUpload.js";

vi.mock("../../api/opsClient.js", () => ({ rpc: vi.fn() }));

const video = new File([new Uint8Array([1, 2, 3])], "交付片段.mp4", { type: "video/mp4" });
const pending: CustomerDeliveryAsset = { assetRef: "asset:upload-one", name: video.name, mimeType: video.type, sizeBytes: video.size, scanStatus: "pending", ready: false };
const ready: CustomerDeliveryAsset = { ...pending, scanStatus: "clean", ready: true };
const item = (id = "one"): Extract<DeliveryUploadItem, { file: File }> => ({ id, file: video, status: "queued" });
const options = () => ({ purpose: "video" as const, signal: new AbortController().signal, upload: vi.fn().mockResolvedValue(pending), getAsset: vi.fn().mockResolvedValue(ready), onChange: vi.fn(), onReady: vi.fn(), pollDelayMs: 0 });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("delivery upload file boundary", () => {
  it("allows only the purpose-specific file types and normalizes missing browser MIME types", () => {
    for (const name of ["合同.pdf", "合同.docx", "合同.png", "合同.JPG", "合同.jpeg"]) {
      expect(validateCustomerDeliveryFile({ name, type: "", size: 1 }, "contract")).toBeTruthy();
    }
    expect(validateCustomerDeliveryFile(video, "video")).toBe("video/mp4");
    expect(validateCustomerDeliveryFile({ name: "demo.webm", type: "", size: 1 }, "video")).toBe("video/webm");
    expect(() => validateCustomerDeliveryFile(video, "contract")).toThrow("交付凭证仅支持");
    expect(() => validateCustomerDeliveryFile({ name: "demo.pdf", type: "application/pdf", size: 1 }, "video")).toThrow("交付视频仅支持");
    expect(() => validateCustomerDeliveryFile({ name: "demo.pdf", type: "text/html", size: 1 }, "contract")).toThrow("不一致");
  });

  it("rejects empty, oversized, and invalidly named files before reading them", () => {
    expect(() => validateCustomerDeliveryFile({ ...video, name: "x.mp4", type: "", size: 0 }, "video")).toThrow("空文件");
    expect(() => validateCustomerDeliveryFile({ name: "x.mp4", type: "", size: CUSTOMER_DELIVERY_MAX_FILE_BYTES + 1 }, "video")).toThrow("50 MiB");
    expect(validateCustomerDeliveryFile({ name: "x.mp4", type: "", size: CUSTOMER_DELIVERY_MAX_FILE_BYTES }, "video")).toBe("video/mp4");
    expect(() => validateCustomerDeliveryFile({ name: "../x.mp4", type: "", size: 1 }, "video")).toThrow("文件名无效");
  });

  it("reads actual bytes and computes their base64 and SHA-256", async () => {
    class Reader {
      result: ArrayBuffer | null = null;
      onload?: () => void;
      onabort?: () => void;
      readAsArrayBuffer(file: File) { void file.arrayBuffer().then((bytes) => { this.result = bytes; this.onload?.(); }); }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("FileReader", Reader);
    const result = await readCustomerDeliveryFile(video, "video");
    expect(result).toEqual({ name: video.name, mimeType: "video/mp4", contentBase64: "AQID", sha256: createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex") });
  });

  it("aborts the FileReader when a drawer is closed", async () => {
    const abort = vi.fn();
    vi.stubGlobal("FileReader", class { readAsArrayBuffer() {} abort() { abort(); } });
    const controller = new AbortController();
    const read = readCustomerDeliveryFile(video, "video", controller.signal);
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("rejects malformed or contradictory scan responses", () => {
    expect(parseCustomerDeliveryAsset(ready)).toEqual(ready);
    expect(parseCustomerDeliveryAsset(pending)).toEqual(pending);
    for (const bad of [null, {}, { ...ready, sizeBytes: -1 }, { ...ready, scanStatus: "pending" }, { ...ready, scanStatus: "blocked" }, { ...ready, ready: "true" }, { ...ready, assetRef: "https://example.test/file" }]) {
      expect(() => parseCustomerDeliveryAsset(bad)).toThrow("安全检查状态");
    }
  });

  it("sends actual file bytes with explicit tenant, delivery, purpose and cancellation context", async () => {
    class Reader {
      result: ArrayBuffer | null = null;
      onload?: () => void;
      readAsArrayBuffer(file: File) { void file.arrayBuffer().then((bytes) => { this.result = bytes; this.onload?.(); }); }
      abort() {}
    }
    vi.stubGlobal("FileReader", Reader);
    vi.mocked(rpc).mockResolvedValue(pending);
    const signal = new AbortController().signal;
    await expect(customerDeliveryClient.uploadAsset({ targetWorkspaceId: "enterprise-a", deliveryId: "delivery-a", purpose: "video", file: video }, signal)).resolves.toEqual(pending);
    expect(rpc).toHaveBeenCalledWith("ops.customer-delivery.assets.upload", {
      target_workspace_id: "enterprise-a",
      delivery_id: "delivery-a",
      purpose: "video",
      name: video.name,
      mime_type: "video/mp4",
      content_base64: "AQID",
      sha256: createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"),
    }, { signal, timeoutMs: 120_000 });
  });

  it("scopes polling to the original tenant and asset, rejecting another asset's result", async () => {
    vi.mocked(rpc).mockResolvedValue(ready);
    const signal = new AbortController().signal;
    const input = { targetWorkspaceId: "enterprise-a", deliveryId: "delivery-a", purpose: "video" as const, assetRef: pending.assetRef };
    await expect(customerDeliveryClient.getAsset(input, signal)).resolves.toEqual(ready);
    expect(rpc).toHaveBeenCalledWith("ops.customer-delivery.assets.get", { target_workspace_id: "enterprise-a", delivery_id: "delivery-a", purpose: "video", asset_ref: pending.assetRef }, { signal });
    vi.mocked(rpc).mockResolvedValue({ ...ready, assetRef: "asset:other" });
    await expect(customerDeliveryClient.getAsset(input, signal)).rejects.toThrow("其他素材");
  });
});

// Real desktop controls and cancellation lifecycle; callback responses are
// deliberately controlled here, not evidence of API authorization or scanning.
describe("contract URL desktop interaction", () => {
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let cacheDirectory: string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "ops-contract-url-"));
    const entryPath = "/__contract-url-entry.tsx";
    vite = await createServer({
      configFile: false,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      cacheDir: cacheDirectory,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
      plugins: [{
        name: "contract-url-interaction",
        resolveId(id) { if (id === entryPath) return `\0${entryPath}`; },
        load(id) {
          if (id !== `\0${entryPath}`) return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { CustomerDeliveryUpload } from '/src/components/delivery/CustomerDeliveryUpload.tsx';
            const h = window.uploadHarness = { uploads: [], checks: [], ready: [], aborted: 0, submits: 0 };
            function Harness() {
              const [disabled, setDisabled] = useState(false);
              const [scope, setScope] = useState('A');
              const [mounted, setMounted] = useState(true);
              const [ref, setRef] = useState('');
              const [busy, setBusy] = useState(false);
              return React.createElement(React.Fragment, null,
                React.createElement('button', { onClick: () => setDisabled(true) }, '撤销上传权限'),
                React.createElement('button', { onClick: () => setMounted(false) }, '关闭上传区域'),
                React.createElement('button', { onClick: () => setScope('B') }, '切换目标'),
                React.createElement('form', { onSubmit: event => { event.preventDefault(); h.submits++; } },
                  mounted ? React.createElement(CustomerDeliveryUpload, {
                    key: scope, purpose: 'contract', disabled,
                    onUpload: (source, purpose, signal) => {
                      h.uploads.push({ source, purpose, scope });
                      signal.addEventListener('abort', () => { h.aborted++; }, { once: true });
                      return new Promise((resolve, reject) => { h.resolveUpload = resolve; h.rejectUpload = reject; });
                    },
                    onGetAsset: (assetRef, purpose, signal) => {
                      h.checks.push({ assetRef, purpose, aborted: signal.aborted });
                      return new Promise((resolve, reject) => { h.resolveCheck = resolve; h.rejectCheck = reject; });
                    },
                    onReady: asset => { h.ready.push({ asset, scope }); setRef(asset.assetRef); },
                    onBusyChange: setBusy,
                  }) : null,
                  React.createElement('input', { 'aria-label': '合同凭证编号', readOnly: true, value: ref }),
                  React.createElement('button', { type: 'submit', disabled: busy }, '保存测试合同')));
            }
            createRoot(document.getElementById('root')).render(React.createElement(Harness));
          `;
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__contract-url-test")) return next();
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
    if (!address || typeof address === "string") throw new Error("Contract URL test listener did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
  }, 60_000);

  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      try { await vite?.close(); }
      finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
    }
  }, 60_000);

  const contractPending = { ...pending, name: "contract.pdf", mimeType: "application/pdf" };
  const contractReady = { ...contractPending, scanStatus: "clean", ready: true };
  async function prepare(page: Page) {
    page.setDefaultTimeout(5_000);
    await page.goto(`${baseUrl}/__contract-url-test`);
    await page.getByText("链接导入", { exact: true }).click();
    expect(await page.getByRole("radio", { name: "链接导入", exact: true }).isChecked()).toBe(true);
  }
  async function finishPending(page: Page) {
    await page.evaluate(asset => (window as any).uploadHarness.resolveUpload(asset), contractPending);
    await expect.poll(() => page.evaluate("window.uploadHarness.checks.length"), { timeout: 5_000 }).toBe(1);
  }

  it("validates inline, imports explicitly once and blocks saving until scanning succeeds", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await prepare(page);
      const input = page.getByRole("textbox", { name: "合同文件直链", exact: true });
      await input.fill("http://files.example.test/contract.pdf");
      await page.getByRole("button", { name: "导入并检查", exact: true }).click();
      expect(await input.getAttribute("aria-invalid")).toBe("true");
      expect(await page.getByRole("alert").textContent()).toContain("HTTPS");
      expect(await page.evaluate("window.uploadHarness.uploads.length")).toBe(0);
      await input.fill("https://files.example.test/contract.pdf");
      expect(await page.evaluate("window.uploadHarness.uploads.length")).toBe(0);
      await input.press("Enter");
      expect(await page.evaluate("window.uploadHarness.submits")).toBe(0);
      expect(await page.getByRole("button", { name: "导入并检查", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "保存测试合同" }).isDisabled()).toBe(true);
      expect(await page.getByRole("textbox", { name: "合同凭证编号" }).inputValue()).toBe("");
      await expect.poll(() => page.getByText("下载中", { exact: true }).isVisible()).toBe(true);
      await finishPending(page);
      expect(await page.evaluate("window.uploadHarness.ready.length")).toBe(0);
      await page.evaluate(asset => (window as any).uploadHarness.resolveCheck(asset), contractReady);
      await expect.poll(() => page.getByRole("textbox", { name: "合同凭证编号" }).inputValue()).toBe(contractReady.assetRef);
      expect(await page.evaluate("window.uploadHarness.uploads")).toEqual([{ source: { sourceUrl: "https://files.example.test/contract.pdf" }, purpose: "contract", scope: "A" }]);
      expect(await page.getByRole("button", { name: "保存测试合同" }).isEnabled()).toBe(true);
    } finally { await page.close(); }
  }, 30_000);

  it.each(["取消导入与检查", "撤销上传权限", "关闭上传区域", "切换目标"])("cancels a pending download at %s and rejects its late response", async action => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await prepare(page);
      await page.getByRole("textbox", { name: "合同文件直链", exact: true }).fill("https://files.example.test/contract.pdf");
      await page.getByRole("button", { name: "导入并检查", exact: true }).dblclick();
      expect(await page.evaluate("window.uploadHarness.uploads.length")).toBe(1);
      await page.getByRole("button", { name: action, exact: true }).click();
      expect(await page.evaluate("window.uploadHarness.aborted")).toBe(1);
      await page.evaluate(asset => (window as any).uploadHarness.resolveUpload(asset), contractReady);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate("window.uploadHarness.ready")).toEqual([]);
      expect(await page.evaluate("window.uploadHarness.checks")).toEqual([]);
      expect(await page.getByRole("textbox", { name: "合同凭证编号" }).inputValue()).toBe("");
      if (action === "取消导入与检查") await expect.poll(() => page.getByRole("button", { name: "重试检查", exact: true }).isVisible()).toBe(true);
    } finally { await page.close(); }
  }, 30_000);

  it("keeps a downloaded contract for an explicit scan retry without importing again", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await prepare(page);
      await page.getByRole("textbox", { name: "合同文件直链", exact: true }).fill("https://files.example.test/contract.pdf");
      await page.getByRole("button", { name: "导入并检查", exact: true }).click();
      await finishPending(page);
      await page.evaluate("window.uploadHarness.rejectCheck(new Error('扫描状态暂不可用，请重试检查'))");
      await page.getByRole("button", { name: "重试检查", exact: true }).click();
      await expect.poll(() => page.evaluate("window.uploadHarness.checks.length"), { timeout: 5_000 }).toBe(2);
      await page.evaluate(asset => (window as any).uploadHarness.resolveCheck(asset), contractReady);
      await expect.poll(() => page.getByRole("textbox", { name: "合同凭证编号" }).inputValue()).toBe(contractReady.assetRef);
      expect(await page.evaluate("window.uploadHarness.uploads.length")).toBe(1);
    } finally { await page.close(); }
  }, 30_000);

  it("supports explicit retry after a download failure, but never accepts a blocked contract", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await prepare(page);
      const input = page.getByRole("textbox", { name: "合同文件直链", exact: true });
      await input.fill("https://files.example.test/contract.pdf");
      await page.getByRole("button", { name: "导入并检查", exact: true }).click();
      await page.evaluate("window.uploadHarness.rejectUpload(new Error('无法下载合同，请确认是公开文件直链'))");
      await page.getByRole("button", { name: "重试导入", exact: true }).click();
      expect(await input.inputValue()).toBe("https://files.example.test/contract.pdf");
      expect(await page.evaluate("window.uploadHarness.uploads.length")).toBe(2);
      await page.evaluate(asset => (window as any).uploadHarness.resolveUpload(asset), { ...contractPending, scanStatus: "blocked" });
      await expect.poll(() => page.getByText("文件未通过安全检查，不能使用；请检查文件后重试", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("textbox", { name: "合同凭证编号" }).inputValue()).toBe("");
      expect(await page.evaluate("window.uploadHarness.ready")).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("aborts a running scan on permission revocation and ignores its late clean result", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await prepare(page);
      await page.getByRole("textbox", { name: "合同文件直链", exact: true }).fill("https://files.example.test/contract.pdf");
      await page.getByRole("button", { name: "导入并检查", exact: true }).click();
      await finishPending(page);
      await page.getByRole("button", { name: "撤销上传权限", exact: true }).click();
      expect(await page.evaluate("window.uploadHarness.aborted")).toBe(1);
      await page.evaluate(asset => (window as any).uploadHarness.resolveCheck(asset), contractReady);
      await expect.poll(() => page.getByText("已取消", { exact: true }).isVisible()).toBe(true);
      expect(await page.evaluate("window.uploadHarness.ready")).toEqual([]);
      expect(await page.getByRole("textbox", { name: "合同凭证编号" }).inputValue()).toBe("");
      expect(await page.getByRole("button", { name: "重试检查", exact: true }).isDisabled()).toBe(true);
    } finally { await page.close(); }
  }, 30_000);
});

describe("delivery upload lifecycle", () => {
  it("downloads a contract URL and only publishes its scanned asset, never the source URL", async () => {
    const callbacks = { ...options(), purpose: "contract" as const };
    const sourceUrl = "https://files.example.test/contract.pdf";
    await runCustomerDeliveryUploadBatch([{ id: "contract", sourceUrl, status: "queued" }], callbacks);
    expect(callbacks.upload).toHaveBeenCalledExactlyOnceWith({ sourceUrl }, "contract", callbacks.signal);
    expect(callbacks.onChange.mock.calls.map(([value]) => value.status)).toEqual(["downloading", "scanning", "ready"]);
    expect(callbacks.getAsset).toHaveBeenCalledExactlyOnceWith(pending.assetRef, "contract", callbacks.signal);
    expect(callbacks.onReady).toHaveBeenCalledExactlyOnceWith(ready);
  });

  it("retains a downloaded asset when scanning fails and retries checking without re-downloading", async () => {
    const callbacks = { ...options(), purpose: "contract" as const };
    callbacks.getAsset.mockRejectedValueOnce(new Error("扫描状态暂不可用"));
    await runCustomerDeliveryUploadBatch([{ id: "contract", sourceUrl: "https://files.example.test/contract.pdf", status: "queued" }], callbacks);
    const failed = callbacks.onChange.mock.lastCall?.[0] as DeliveryUploadItem;
    expect(failed).toMatchObject({ status: "failed", asset: pending });
    expect(callbacks.onReady).not.toHaveBeenCalled();
    callbacks.upload.mockClear();
    await runCustomerDeliveryUploadBatch([failed], callbacks);
    expect(callbacks.upload).not.toHaveBeenCalled();
    expect(callbacks.onReady).toHaveBeenCalledExactlyOnceWith(ready);
  });

  it("cancels a late contract download without publishing it or polling", async () => {
    const controller = new AbortController();
    const callbacks = { ...options(), purpose: "contract" as const, signal: controller.signal };
    let resolveUpload!: (asset: CustomerDeliveryAsset) => void;
    callbacks.upload.mockReturnValue(new Promise((resolve) => { resolveUpload = resolve; }));
    const run = runCustomerDeliveryUploadBatch([{ id: "contract", sourceUrl: "https://files.example.test/contract.pdf", status: "queued" }], callbacks);
    controller.abort();
    resolveUpload(ready);
    await run;
    expect(callbacks.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "cancelled" }));
    expect(callbacks.onReady).not.toHaveBeenCalled();
    expect(callbacks.getAsset).not.toHaveBeenCalled();
  });

  it("does not import URLs for other evidence purposes or publish blocked contracts", async () => {
    const callbacks = options();
    const source: DeliveryUploadItem = { id: "contract", sourceUrl: "https://files.example.test/contract.pdf", status: "queued" };
    await runCustomerDeliveryUploadBatch([source], callbacks);
    expect(callbacks.upload).not.toHaveBeenCalled();
    expect(callbacks.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: expect.stringContaining("仅合同") }));
    callbacks.upload.mockResolvedValue({ ...pending, scanStatus: "blocked" });
    await runCustomerDeliveryUploadBatch([source], { ...callbacks, purpose: "contract" });
    expect(callbacks.onReady).not.toHaveBeenCalled();
    expect(callbacks.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: expect.stringContaining("未通过安全检查") }));
  });

  it.each(["contract", "payment", "system_integration", "functional_acceptance", "training", "video"] as const)("offers URL import only for contract evidence: %s", (purpose) => {
    const html = renderToStaticMarkup(<CustomerDeliveryUpload purpose={purpose} onUpload={options().upload} onGetAsset={options().getAsset} onReady={() => {}} />);
    expect(html.includes("链接导入")).toBe(purpose === "contract");
  });

  it("reports upload then scan then ready, and only publishes an accepted asset", async () => {
    const callbacks = options();
    await runCustomerDeliveryUploadBatch([item()], callbacks);
    expect(callbacks.onChange.mock.calls.map(([value]) => value.status)).toEqual(["uploading", "scanning", "ready"]);
    expect(callbacks.onReady).toHaveBeenCalledExactlyOnceWith(ready);
    expect(callbacks.getAsset).toHaveBeenCalledWith(pending.assetRef, "video", callbacks.signal);
  });

  it("never publishes a blocked file", async () => {
    const callbacks = options();
    callbacks.getAsset.mockResolvedValue({ ...pending, scanStatus: "blocked" });
    await runCustomerDeliveryUploadBatch([item()], callbacks);
    expect(callbacks.onReady).not.toHaveBeenCalled();
    expect(callbacks.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: expect.stringContaining("未通过安全检查") }));
  });

  it("rejects even a callback that incorrectly claims a pending asset is ready", async () => {
    const callbacks = options();
    callbacks.upload.mockResolvedValue({ ...pending, ready: true });
    await runCustomerDeliveryUploadBatch([item()], callbacks);
    expect(callbacks.onReady).not.toHaveBeenCalled();
    expect(callbacks.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("uploads sequentially and preserves successful files around a failure", async () => {
    const callbacks = options();
    callbacks.upload.mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error("第二段上传失败")).mockResolvedValueOnce({ ...ready, assetRef: "asset:three" });
    await runCustomerDeliveryUploadBatch([item("one"), item("two"), item("three")], callbacks);
    expect(callbacks.onReady.mock.calls.map(([asset]) => asset.assetRef)).toEqual(["asset:upload-one", "asset:three"]);
    expect(callbacks.onChange.mock.calls.map(([value]) => `${value.id}:${value.status}`)).toEqual(["one:uploading", "one:ready", "two:uploading", "two:failed", "three:uploading", "three:ready"]);
  });

  it("does not upload an invalid file and continues with other valid files", async () => {
    const callbacks = options();
    callbacks.upload.mockResolvedValue(ready);
    await runCustomerDeliveryUploadBatch([{ ...item("bad"), file: new File(["html"], "page.html", { type: "text/html" }) }, item()], callbacks);
    expect(callbacks.upload).toHaveBeenCalledOnce();
    expect(callbacks.onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "bad", status: "failed" }));
    expect(callbacks.onReady).toHaveBeenCalledExactlyOnceWith(ready);
  });

  it("keeps the uploaded asset on scan timeout and retries without uploading again", async () => {
    const callbacks = options();
    await runCustomerDeliveryUploadBatch([item()], { ...callbacks, maxPolls: 0 });
    const failed = callbacks.onChange.mock.lastCall?.[0] as DeliveryUploadItem;
    expect(failed).toMatchObject({ status: "failed", asset: pending });
    expect(callbacks.onReady).not.toHaveBeenCalled();
    callbacks.upload.mockClear();
    await runCustomerDeliveryUploadBatch([failed], callbacks);
    expect(callbacks.upload).not.toHaveBeenCalled();
    expect(callbacks.onReady).toHaveBeenCalledExactlyOnceWith(ready);
  });

  it("rejects a scan response for a different asset", async () => {
    const callbacks = options();
    callbacks.getAsset.mockResolvedValue({ ...ready, assetRef: "asset:other-customer" });
    await runCustomerDeliveryUploadBatch([item()], callbacks);
    expect(callbacks.onReady).not.toHaveBeenCalled();
    expect(callbacks.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: expect.stringContaining("素材不匹配") }));
    expect(callbacks.onChange.mock.lastCall?.[0].asset.assetRef).toBe(pending.assetRef);
  });

  it("prevents a late upload response from filling a switched or closed form", async () => {
    const controller = new AbortController();
    const callbacks = options();
    let resolveUpload!: (asset: CustomerDeliveryAsset) => void;
    callbacks.upload.mockReturnValue(new Promise((resolve) => { resolveUpload = resolve; }));
    const run = runCustomerDeliveryUploadBatch([item(), item("two")], { ...callbacks, signal: controller.signal });
    controller.abort();
    resolveUpload(ready);
    await run;
    expect(callbacks.onReady).not.toHaveBeenCalled();
    expect(callbacks.upload).toHaveBeenCalledOnce();
    expect(callbacks.onChange.mock.calls.filter(([value]) => value.status === "cancelled")).toHaveLength(2);
  });

  it("cancels polling timers immediately", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const wait = waitForDeliveryScan(2000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not render a fake upload button without both API callbacks", () => {
    expect(renderToStaticMarkup(<CustomerDeliveryUpload purpose="contract" onReady={() => {}} />)).toBe("");
    expect(renderToStaticMarkup(<CustomerDeliveryUpload purpose="video" onUpload={options().upload} onReady={() => {}} />)).toBe("");
    const html = renderToStaticMarkup(<CustomerDeliveryUpload purpose="video" onUpload={options().upload} onGetAsset={options().getAsset} onReady={() => {}} />);
    expect(html).toContain("上传交付视频");
    expect(html).toContain("50 MiB");
    expect(html).toContain('accept=".mp4,.webm"');
  });

  it.each([
    ["contract", "上传合同文件", ".pdf,.docx,.png,.jpg,.jpeg"],
    ["payment", "上传付款凭证", ".pdf,.docx,.png,.jpg,.jpeg"],
    ["system_integration", "上传系统接入凭证", ".pdf,.docx,.png,.jpg,.jpeg"],
    ["functional_acceptance", "上传功能验收凭证", ".pdf,.docx,.png,.jpg,.jpeg"],
    ["training", "上传培训凭证", ".pdf,.docx,.png,.jpg,.jpeg"],
    ["video", "上传交付视频", ".mp4,.webm"],
  ] as const)("exposes a purpose-specific upload label for %s", (purpose, label, accept) => {
    const html = renderToStaticMarkup(
      <CustomerDeliveryUpload
        purpose={purpose}
        onUpload={options().upload}
        onGetAsset={options().getAsset}
        onReady={() => {}}
      />,
    );
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`data-testid="customer-delivery-upload-${purpose}"`);
    expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain(`accept="${accept}"`);
  });
});
