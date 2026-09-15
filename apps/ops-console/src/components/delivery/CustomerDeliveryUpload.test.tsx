import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const item = (id = "one"): DeliveryUploadItem => ({ id, file: video, status: "queued" });
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

describe("delivery upload lifecycle", () => {
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
    expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain(`accept="${accept}"`);
  });
});
