import { useEffect, useRef, useState } from "react";
import { Button, Space, Spin, Tag, Typography } from "antd";
import {
  validateCustomerDeliveryFile,
  type CustomerDeliveryAsset,
  type CustomerDeliveryAssetPurpose,
} from "../../api/customerDeliveryClient.js";

export type DeliveryUploadStatus = "queued" | "uploading" | "scanning" | "ready" | "failed" | "cancelled";
export interface DeliveryUploadItem {
  id: string;
  file: File;
  status: DeliveryUploadStatus;
  asset?: CustomerDeliveryAsset;
  error?: string;
}
type Upload = (file: File, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
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
      validateCustomerDeliveryFile(item.file, options.purpose);
      if (!asset) {
        options.onChange({ ...item, status: "uploading", error: undefined });
        asset = await options.upload(item.file, options.purpose, options.signal);
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
  scanning: "安全检查中",
  ready: "可使用",
  failed: "失败",
  cancelled: "已取消",
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
  const input = useRef<HTMLInputElement>(null);
  const nextItemId = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      busyCallback.current?.(false);
    };
  }, []);
  if (!onUpload || !onGetAsset) return null;
  const start = async (batch: DeliveryUploadItem[]) => {
    if (controller.current || !batch.length) return;
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
        onReady: (asset) => { if (mounted.current && !current.signal.aborted) onReady(asset); },
      });
    } finally {
      if (controller.current === current) controller.current = undefined;
      if (mounted.current) { setBusy(false); busyCallback.current?.(false); }
    }
  };
  const label = purpose === "contract" ? "上传合同文件" : "上传交付视频";
  return (
    <div style={{ marginBottom: 16 }} aria-busy={busy}>
      <input
        ref={input}
        type="file"
        aria-label={label}
        style={{ display: "none" }}
        accept={purpose === "contract" ? ".pdf,.docx,.png,.jpg,.jpeg" : ".mp4,.webm"}
        multiple={purpose === "video"}
        disabled={disabled || busy}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          const batch = (purpose === "contract" ? files.slice(0, 1) : files).map((file): DeliveryUploadItem => ({ id: String(++nextItemId.current), file, status: "queued" }));
          setItems((previous) => [...previous, ...batch]);
          void start(batch);
        }}
      />
      <Space wrap>
        <Button disabled={disabled || busy} onClick={() => input.current?.click()}>{label}</Button>
        {busy ? <Button onClick={() => controller.current?.abort()}>取消上传与检查</Button> : null}
      </Space>
      <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>
        {purpose === "contract" ? "PDF、DOCX、PNG、JPG、JPEG" : "MP4、WebM，可多选并逐段上传"}；单文件不超过 50 MiB。安全检查通过后填入素材编号，保存当前环节后才会登记。
      </Typography.Text>
      <div role="status" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div key={item.id} style={{ marginTop: 12 }}>
            <Space wrap size="small">
              <Typography.Text style={{ overflowWrap: "anywhere" }}>{item.file.name}</Typography.Text>
              {(item.status === "uploading" || item.status === "scanning") ? <Spin size="small" /> : null}
              <Tag color={item.status === "ready" ? "success" : item.status === "failed" ? "error" : "default"}>{statusLabels[item.status]}</Tag>
              {(item.status === "failed" || item.status === "cancelled") ? (
                <Button size="small" disabled={disabled || busy} onClick={() => void start([{ ...item, asset: item.asset?.scanStatus === "blocked" ? undefined : item.asset }])}>
                  {item.asset && item.asset.scanStatus !== "blocked" ? "重试检查" : "重试上传"}
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
