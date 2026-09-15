import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button, Input, Radio, Space, Spin, Tag, Typography } from "antd";
import {
  validateCustomerDeliveryContractUrl,
  validateCustomerDeliveryFile,
  type CustomerDeliveryAsset,
  type CustomerDeliveryAssetPurpose,
  type CustomerDeliveryUploadSource,
} from "../../api/customerDeliveryClient.js";

export type DeliveryUploadStatus = "queued" | "uploading" | "downloading" | "scanning" | "ready" | "failed" | "cancelled";
export type DeliveryUploadItem = {
  id: string;
  status: DeliveryUploadStatus;
  asset?: CustomerDeliveryAsset;
  error?: string;
} & ({ file: File; sourceUrl?: never } | { sourceUrl: string; file?: never });
type Upload = (source: CustomerDeliveryUploadSource, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
type GetAsset = (assetRef: string, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;

export function waitForDeliveryScan(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("安全检查等待已取消", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Each file has its own outcome. A rejected segment cannot discard accepted ones. */
export async function runCustomerDeliveryUploadBatch(items: DeliveryUploadItem[], options: {
  purpose: CustomerDeliveryAssetPurpose;
  signal: AbortSignal;
  upload: Upload;
  getAsset: GetAsset;
  onChange: (item: DeliveryUploadItem) => void;
  onReady: (asset: CustomerDeliveryAsset) => void;
  pollDelayMs?: number;
  maxPolls?: number;
}) {
  for (const item of items) {
    let asset = item.asset;
    if (options.signal.aborted) {
      options.onChange({ ...item, status: "cancelled", error: "已取消；不会自动登记此文件" });
      continue;
    }
    try {
      const fromUrl = "sourceUrl" in item;
      let source: CustomerDeliveryUploadSource;
      if (fromUrl) {
        if (options.purpose !== "contract" || typeof item.sourceUrl !== "string" || "file" in item) throw new Error("仅合同凭证支持链接导入，且不能同时选择文件");
        source = { sourceUrl: validateCustomerDeliveryContractUrl(item.sourceUrl) };
      } else {
        validateCustomerDeliveryFile(item.file, options.purpose);
        source = item.file;
      }
      if (!asset) {
        options.onChange({ ...item, status: fromUrl ? "downloading" : "uploading", error: undefined });
        asset = await options.upload(source, options.purpose, options.signal);
        options.signal.throwIfAborted();
      }
      const assetRef = asset.assetRef;
      let polls = 0;
      while (!asset.ready) {
        if (asset.scanStatus === "blocked") throw new Error("文件未通过安全检查，不能使用；请检查文件后重试");
        options.onChange({ ...item, asset, status: "scanning", error: undefined });
        if (polls++ >= (options.maxPolls ?? 90)) throw new Error("安全检查尚未完成；可稍后重试检查，无需重复上传");
        await waitForDeliveryScan(options.pollDelayMs ?? 2000, options.signal);
        const checkedAsset = await options.getAsset(assetRef, options.purpose, options.signal);
        options.signal.throwIfAborted();
        if (checkedAsset.assetRef !== assetRef) throw new Error("安全检查素材不匹配，已阻止登记");
        asset = checkedAsset;
      }
      if (asset.scanStatus !== "clean") throw new Error("文件缺少可信安全检查结果，不能使用");
      options.signal.throwIfAborted();
      options.onReady(asset);
      options.onChange({ ...item, asset, status: "ready", error: undefined });
    } catch (error) {
      const cancelled = options.signal.aborted;
      options.onChange({
        ...item,
        asset,
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? "已取消；不会自动登记此文件" : error instanceof Error ? error.message : "上传或安全检查失败，请重试",
      });
    }
  }
}

const statusLabels: Record<DeliveryUploadStatus, string> = {
  queued: "等待上传",
  uploading: "上传中",
  downloading: "下载中",
  scanning: "安全检查中",
  ready: "可使用",
  failed: "失败",
  cancelled: "已取消",
};

const uploadLabels: Record<CustomerDeliveryAssetPurpose, string> = {
  contract: "上传合同文件",
  payment: "上传付款凭证",
  system_integration: "上传系统接入凭证",
  functional_acceptance: "上传功能验收凭证",
  training: "上传培训凭证",
  video: "上传交付视频",
};

const uploadAccept: Record<CustomerDeliveryAssetPurpose, string> = {
  contract: ".pdf,.docx,.png,.jpg,.jpeg",
  payment: ".pdf,.docx,.png,.jpg,.jpeg",
  system_integration: ".pdf,.docx,.png,.jpg,.jpeg",
  functional_acceptance: ".pdf,.docx,.png,.jpg,.jpeg",
  training: ".pdf,.docx,.png,.jpg,.jpeg",
  video: ".mp4,.webm",
};

export function CustomerDeliveryUpload({ purpose, disabled = false, onUpload, onGetAsset, onReady, onBusyChange }: {
  purpose: CustomerDeliveryAssetPurpose;
  disabled?: boolean;
  onUpload?: Upload;
  onGetAsset?: GetAsset;
  onReady: (asset: CustomerDeliveryAsset) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<DeliveryUploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [sourceMode, setSourceMode] = useState<"file" | "url">("file");
  const [sourceUrl, setSourceUrl] = useState("");
  const [urlError, setUrlError] = useState<string>();
  const urlInputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const urlInput = useRef<import("antd").InputRef>(null);
  const nextItemId = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const available = useRef(!disabled && Boolean(onUpload && onGetAsset));
  available.current = !disabled && Boolean(onUpload && onGetAsset);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      busyCallback.current?.(false);
    };
  }, []);
  useLayoutEffect(() => {
    if (disabled || !onUpload || !onGetAsset) controller.current?.abort();
  }, [disabled, onUpload, onGetAsset]);
  if (!onUpload || !onGetAsset) return null;
  const start = async (batch: DeliveryUploadItem[]) => {
    if (!mounted.current || !available.current || controller.current || !batch.length) return;
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    busyCallback.current?.(true);
    try {
      await runCustomerDeliveryUploadBatch(batch, {
        purpose,
        signal: current.signal,
        upload: onUpload,
        getAsset: onGetAsset,
        onChange: (updated) => {
          if (mounted.current) setItems((previous) => previous.map((item) => item.id === updated.id ? updated : item));
        },
        onReady: (asset) => { if (mounted.current && available.current && !current.signal.aborted) onReady(asset); },
      });
    } finally {
      if (controller.current === current) controller.current = undefined;
      if (mounted.current) { setBusy(false); busyCallback.current?.(false); }
    }
  };
  const label = uploadLabels[purpose];
  const isVideo = purpose === "video";
  const isUrlMode = purpose === "contract" && sourceMode === "url";
  const importContract = () => {
    if (!available.current || controller.current) return;
    try {
      const validatedUrl = validateCustomerDeliveryContractUrl(sourceUrl);
      setUrlError(undefined);
      const item: DeliveryUploadItem = { id: String(++nextItemId.current), sourceUrl: validatedUrl, status: "queued" };
      setItems((previous) => [...previous, item]);
      void start([item]);
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : "合同链接无效，请检查后重试");
      urlInput.current?.focus();
    }
  };
  return (
    <div style={{ marginBottom: 16 }} aria-busy={busy}>
      {purpose === "contract" ? (
        <Radio.Group aria-label="合同凭证来源" value={sourceMode} disabled={disabled || busy} onChange={(event) => setSourceMode(event.target.value)} style={{ display: "block", marginBottom: 12 }}>
          <Radio.Button value="file">本地文件</Radio.Button>
          <Radio.Button value="url">链接导入</Radio.Button>
        </Radio.Group>
      ) : null}
      <input
        ref={input}
        type="file"
        aria-label={label}
        data-testid={`customer-delivery-upload-${purpose}`}
        style={{ display: "none" }}
        accept={uploadAccept[purpose]}
        multiple={isVideo}
        disabled={disabled || busy}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (!available.current || controller.current) return;
          const batch = (purpose === "contract" ? files.slice(0, 1) : files).map((file): DeliveryUploadItem => ({ id: String(++nextItemId.current), file, status: "queued" }));
          setItems((previous) => [...previous, ...batch]);
          void start(batch);
        }}
      />
      {isUrlMode ? (
        <div style={{ marginBottom: 8 }}>
          <label htmlFor={urlInputId} style={{ display: "block", marginBottom: 8 }}>合同文件直链</label>
          <Input
            ref={urlInput}
            id={urlInputId}
            type="url"
            value={sourceUrl}
            placeholder="https://example.com/contract.pdf"
            autoComplete="off"
            disabled={disabled || busy}
            status={urlError ? "error" : undefined}
            aria-invalid={Boolean(urlError)}
            aria-describedby={`${urlInputId}-help${urlError ? ` ${urlInputId}-error` : ""}`}
            onChange={(event) => { setSourceUrl(event.target.value); setUrlError(undefined); }}
            onBlur={() => {
              if (!sourceUrl.trim()) return;
              try { validateCustomerDeliveryContractUrl(sourceUrl); setUrlError(undefined); }
              catch (error) { setUrlError(error instanceof Error ? error.message : "合同链接无效"); }
            }}
            onPressEnter={(event) => { event.preventDefault(); importContract(); }}
          />
          <Typography.Text id={`${urlInputId}-help`} type="secondary" style={{ display: "block", marginTop: 8 }}>
            仅支持公开可下载的 HTTPS 文件直链，不跟随跳转。分享页或需登录的网盘链接，请先下载文件再本地上传。
          </Typography.Text>
          {urlError ? <Typography.Text id={`${urlInputId}-error`} role="alert" type="danger" style={{ display: "block", marginTop: 4 }}>{urlError}</Typography.Text> : null}
        </div>
      ) : null}
      <Space wrap>
        {isUrlMode ? <Button disabled={disabled || busy} onClick={importContract}>导入并检查</Button> : <Button disabled={disabled || busy} onClick={() => input.current?.click()}>{label}</Button>}
        {busy ? <Button onClick={() => controller.current?.abort()}>{isUrlMode ? "取消导入与检查" : "取消上传与检查"}</Button> : null}
      </Space>
      <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>
        {isVideo ? "MP4、WebM，可多选并逐段上传" : "PDF、DOCX、PNG、JPG、JPEG"}；单文件不超过 50 MiB。安全检查通过后填入素材编号，保存当前环节后才会登记。
      </Typography.Text>
      <div role="status" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div key={item.id} style={{ marginTop: 12 }}>
            <Space wrap size="small">
              <Typography.Text style={{ overflowWrap: "anywhere" }}>{item.file?.name ?? item.asset?.name ?? "合同链接文件"}</Typography.Text>
              {(item.status === "uploading" || item.status === "downloading" || item.status === "scanning") ? <Spin size="small" /> : null}
              <Tag color={item.status === "ready" ? "success" : item.status === "failed" ? "error" : "default"}>{statusLabels[item.status]}</Tag>
              {(item.status === "failed" || item.status === "cancelled") ? (
                <Button size="small" disabled={disabled || busy} onClick={() => void start([{ ...item, asset: item.asset?.scanStatus === "blocked" ? undefined : item.asset }])}>
                  {item.asset && item.asset.scanStatus !== "blocked" ? "重试检查" : item.sourceUrl ? "重试导入" : "重试上传"}
                </Button>
              ) : null}
            </Space>
            {item.error ? <Typography.Text type="danger" style={{ display: "block", marginTop: 4 }}>{item.error}</Typography.Text> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
