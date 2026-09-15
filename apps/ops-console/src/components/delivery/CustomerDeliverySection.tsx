import { useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Form,
  Input,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { deliveryCompletionTimeLabel, deliveryDateTimeInputValue } from "./deliveryDateTime.js";
import { CustomerDeliveryUpload } from "./CustomerDeliveryUpload.js";
import { parseCustomerDeliveryEvidenceRefs } from "../../api/customerDeliveryClient.js";
import type { CustomerDeliveryAsset, CustomerDeliveryAssetPurpose } from "../../api/customerDeliveryClient.js";

export type DeliveryStepKey =
  "profile" | "integration" | "acceptance" | "training" | "video";
export interface CustomerDeliveryRecord {
  id: string;
  companyName: string;
  contractNo?: string;
  paymentStatus: "unpaid" | "paid";
  profile: boolean;
  integration: boolean;
  acceptance: boolean;
  training: boolean;
  videos: number;
  goLiveAt?: string;
  owner?: string;
  afterSalesOwner?: string;
  paymentDate?: string;
  requiredLaunchAt?: string;
  contractFile?: string;
  paymentEvidenceRefs?: string[];
  trainingEvidenceRefs?: string[];
  integrationItems?: string[];
  acceptanceItems?: string[];
  trainingCompletedAt?: string;
  videoUrls?: string[];
  revision?: number;
  /** Per-item evidence returned by the delivery API. Keys are item labels. */
  integrationEvidence?: Record<string, string>;
  acceptanceEvidence?: Record<string, string>;
  integrationEvidenceAssetRefs?: Record<string, string[]>;
  acceptanceEvidenceAssetRefs?: Record<string, string[]>;
}

export interface CustomerDeliveryChecklistItem {
  itemKey: string;
  completed: boolean;
  /** Explicitly empty when an item has no evidence yet; the API may reject it. */
  evidence: string;
  evidenceAssetRefs: string[];
}

export interface CustomerDeliveryChecklistSave {
  record: CustomerDeliveryRecord;
  checklistKey: "system_integration" | "functional_acceptance";
  items: CustomerDeliveryChecklistItem[];
}

export interface CustomerDeliveryVideoItem {
  id: string;
  title: string;
  assetRef: string;
  sortOrder: number;
}

export const INTEGRATION_ITEMS = [
  "插件账号",
  "店铺连接",
  "商品扫描",
  "知识库",
  "平台规则",
  "创意点数",
  "企业信息",
  "品牌资产",
  "商品资料",
  "客户偏好",
];
export const ACCEPTANCE_ITEMS = [
  "文案生成",
  "图片生成",
  "标注编辑",
  "自动检查",
  "视频生成",
  "店铺/商品读取",
  "技术验收",
  "内容验收",
];

/** Fits the 1440px desktop workbench without hiding the final status column. */
export const CUSTOMER_DELIVERY_TABLE_WIDTHS = {
  sequence: 56,
  company: 196,
  profile: 88,
  integration: 88,
  acceptance: 122,
  training: 148,
  video: 82,
  completedAt: 172,
  status: 136,
} as const;

/**
 * Persisted checklist keys intentionally remain stable for API compatibility.
 * These display labels follow the customer-delivery brief without requiring a
 * data migration for records that already use the original keys.
 */
export const CHECKLIST_DISPLAY_LABELS: Record<string, string> = {
  插件账号: "插件账户",
  知识库: "知识库功能",
  创意点数: "创作点",
  标注编辑: "批注修改",
  "店铺/商品读取": "店铺与商品资料读取",
};

export function checklistDisplayLabel(itemKey: string) {
  return CHECKLIST_DISPLAY_LABELS[itemKey] ?? itemKey;
}

export function buildChecklistItems(
  itemKeys: string[],
  selectedItems: unknown,
  evidence: unknown,
  evidenceAssetRefs: unknown = {},
): CustomerDeliveryChecklistItem[] {
  const selected = Array.isArray(selectedItems)
    ? selectedItems.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const evidenceMap =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : {};
  const assetMap = evidenceAssetRefs && typeof evidenceAssetRefs === "object" && !Array.isArray(evidenceAssetRefs)
    ? evidenceAssetRefs as Record<string, unknown> : {};
  return itemKeys.map((itemKey) => ({
    itemKey,
    completed: selected.includes(itemKey),
    evidence:
      typeof evidenceMap[itemKey] === "string"
        ? evidenceMap[itemKey].trim()
        : "",
    evidenceAssetRefs: parseCustomerDeliveryEvidenceRefs(assetMap[itemKey], `${checklistDisplayLabel(itemKey)}凭证`),
  }));
}

function appendEvidenceRef(form: ReturnType<typeof Form.useForm>[0], field: string | (string | number)[], assetRef: string) {
  const current = form.getFieldValue(field);
  const refs = Array.isArray(current) ? current.filter((value): value is string => typeof value === "string") : [];
  form.setFieldValue(field, [...new Set([...refs, assetRef])]);
}

const stepLabels: Record<DeliveryStepKey, string> = {
  profile: "客户档案",
  integration: "系统接入",
  acceptance: "功能测试及验收",
  training: "客户培训",
  video: "交付视频",
};

export function isDeliveryStepBlocked(
  paymentStatus: CustomerDeliveryRecord["paymentStatus"],
  step: DeliveryStepKey,
) {
  return (
    paymentStatus !== "paid" &&
    ["integration", "acceptance", "training"].includes(step)
  );
}

export function deliveryCompletion(record: CustomerDeliveryRecord) {
  const completed = [
    record.profile,
    record.integration,
    record.acceptance,
    record.training,
    record.videos > 0,
  ].filter(Boolean).length;
  // Payment is a prerequisite for delivery completion. The UI gate prevents unpaid
  // operators from entering controlled steps, but the aggregate must also be
  // fail-closed when data is imported or updated through another route.
  return {
    completed,
    total: 5,
    // Only the server can verify that all attached files and checklist evidence
    // are usable. Legacy checkboxes alone must not claim completed delivery.
    ready: record.paymentStatus === "paid" && completed === 5 && Boolean(record.goLiveAt) && Number.isFinite(Date.parse(record.goLiveAt ?? "")),
  };
}

export function deliveryStatusLabel(result: ReturnType<typeof deliveryCompletion>) {
  return result.ready ? "交付已完成" : `${result.completed}/${result.total}`;
}

export function customerDeliveryTrainingAction(record: CustomerDeliveryRecord, completed: boolean) {
  if (record.paymentStatus !== "paid") return "blocked";
  return completed && !record.trainingEvidenceRefs?.length ? "evidence" : "save";
}

function createUploadTracker() {
  let scope = "";
  const busyUploaders = new Set<string>();
  return {
    beginScope(nextScope = "") { scope = nextScope; busyUploaders.clear(); },
    isCurrent(candidate: string) { return candidate === scope; },
    setBusy(candidate: string, uploader: string, busy: boolean) {
      if (candidate !== scope) return undefined;
      if (busy) busyUploaders.add(uploader);
      else busyUploaders.delete(uploader);
      return busyUploaders.size > 0;
    },
  };
}

export function CustomerDeliveryTrainingEvidence({ record, disabled, onUpload, onGetAsset, onConfirm, onClose }: {
  record: CustomerDeliveryRecord;
  disabled?: boolean;
  onUpload?: (file: File, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
  onGetAsset?: (assetRef: string, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
  onConfirm: (refs: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [refs, setRefs] = useState(record.trainingEvidenceRefs ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = async () => {
    if (busy || disabled) return;
    try {
      const valid = parseCustomerDeliveryEvidenceRefs(refs, "培训凭证");
      if (!valid.length) throw new Error("完成客户培训前请上传培训凭证");
      setError("");
      await onConfirm(valid);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "培训确认失败，请重试"); }
  };
  return <section aria-label={`${record.companyName} 培训凭证`} style={{ padding: "8px 0", minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 12 }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Text strong>培训凭证</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0" }}>上传签到表、培训记录或确认截图，安全检查通过后确认。</Typography.Paragraph>
      </div>
      <Space style={{ flexShrink: 0 }}>
        <Button type="primary" disabled={busy || disabled} onClick={() => void confirm()}>确认培训完成</Button>
        <Button aria-label="收起" onClick={onClose}>收起</Button>
      </Space>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 1fr)", alignItems: "start", gap: 16 }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>已上传培训凭证</Typography.Text>
        <Select
          aria-label="已上传培训凭证"
          mode="tags"
          open={false}
          value={refs}
          onChange={setRefs}
          disabled={disabled}
          placeholder="上传后自动填入，也可填写已绑定素材编号"
          style={{ width: "100%" }}
        />
        {error ? <Typography.Paragraph type="danger" role="alert" style={{ margin: "8px 0 0" }}>{error}</Typography.Paragraph> : null}
      </div>
      <div style={{ minWidth: 0 }}>
        <CustomerDeliveryUpload purpose="training" disabled={disabled} onUpload={onUpload} onGetAsset={onGetAsset} onReady={(asset) => setRefs((current) => [...new Set([...current, asset.assetRef])])} onBusyChange={setBusy} />
      </div>
    </div>
  </section>;
}

export function CustomerDeliverySection({
  disabled = false,
  readOnly = false,
  records = [],
  onOpen,
  onSave,
  onCreate,
  onChecklistSave,
  onChecklistLoad,
  onTrainingSave,
  onVideoAdd,
  onVideoList,
  onAssetUpload,
  onAssetGet,
}: {
  disabled?: boolean;
  /** Keeps delivery details readable while removing every mutation entry. */
  readOnly?: boolean;
  records?: CustomerDeliveryRecord[];
  onOpen?: (
    record: CustomerDeliveryRecord,
    step: DeliveryStepKey,
  ) => Promise<void> | void;
  onSave?: (
    record: CustomerDeliveryRecord,
  ) => Promise<CustomerDeliveryRecord | void> | CustomerDeliveryRecord | void;
  onCreate?: (companyName: string) => Promise<CustomerDeliveryRecord>;
  onChecklistSave?: (
    payload: CustomerDeliveryChecklistSave,
  ) => Promise<CustomerDeliveryRecord | void> | CustomerDeliveryRecord | void;
  onChecklistLoad?: (
    record: CustomerDeliveryRecord,
    checklistKey: "system_integration" | "functional_acceptance",
  ) => Promise<CustomerDeliveryChecklistItem[]>;
  onTrainingSave?: (
    record: CustomerDeliveryRecord,
    completed: boolean,
    evidenceAssetRefs: string[],
  ) => Promise<CustomerDeliveryRecord | void>;
  onVideoAdd?: (
    record: CustomerDeliveryRecord,
    input: { title: string; assetRef: string; sortOrder: number },
  ) => Promise<CustomerDeliveryRecord | void>;
  /** Load persisted segments when opening the video step. */
  onVideoList?: (
    record: CustomerDeliveryRecord,
  ) => Promise<CustomerDeliveryVideoItem[]>;
  onAssetUpload?: (record: CustomerDeliveryRecord, file: File, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
  onAssetGet?: (record: CustomerDeliveryRecord, assetRef: string, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
}) {
  const [selected, setSelected] = useState<CustomerDeliveryRecord>();
  const [step, setStep] = useState<DeliveryStepKey>("profile");
  const [blockedCompany, setBlockedCompany] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [loadingStep, setLoadingStep] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadTracker = useRef(createUploadTracker());
  const detailRequest = useRef(0);
  const [creating, setCreating] = useState(false);
  const [videoItems, setVideoItems] = useState<CustomerDeliveryVideoItem[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [trainingRowId, setTrainingRowId] = useState<string>();
  const [createForm] = Form.useForm();
  const [form] = Form.useForm();
  const openStep = async (
    row: CustomerDeliveryRecord,
    next: DeliveryStepKey,
  ) => {
    if (!readOnly && isDeliveryStepBlocked(row.paymentStatus, next)) {
      setBlockedCompany(row.companyName);
      return;
    }
    setBlockedCompany(undefined);
    setTrainingRowId(undefined);
    const request = ++detailRequest.current;
    uploadTracker.current.beginScope(`${row.id}:${next}:${request}`);
    setUploading(false);
    setLoadingStep(true);
    setSelected(row);
    setStep(next);
    setVideoItems([]);
    form.resetFields();
    form.setFieldsValue({
      ...row,
      requiredLaunchAt: deliveryDateTimeInputValue(row.requiredLaunchAt),
      integrationItems: row.integrationItems ?? [],
      acceptanceItems: row.acceptanceItems ?? [],
      integrationEvidence: row.integrationEvidence ?? {},
      acceptanceEvidence: row.acceptanceEvidence ?? {},
      integrationEvidenceAssetRefs: row.integrationEvidenceAssetRefs ?? {},
      acceptanceEvidenceAssetRefs: row.acceptanceEvidenceAssetRefs ?? {},
      paymentEvidenceRefs: row.paymentEvidenceRefs ?? [],
      trainingEvidenceRefs: row.trainingEvidenceRefs ?? [],
    });
    if ((next === "integration" || next === "acceptance") && onChecklistLoad) {
      const key =
        next === "integration" ? "system_integration" : "functional_acceptance";
      let items: CustomerDeliveryChecklistItem[];
      try {
        items = await onChecklistLoad(row, key);
      } catch (error) {
        if (request !== detailRequest.current) return;
        setLoadingStep(false);
        setSelected(undefined);
        message.error(error instanceof Error ? error.message : "清单读取失败");
        return;
      }
      if (request !== detailRequest.current) return;
      const selectedItems = items
        .filter((item) => item.completed)
        .map((item) => item.itemKey);
      const evidence = Object.fromEntries(
        items.map((item) => [item.itemKey, item.evidence]),
      );
      const evidenceAssetRefs = Object.fromEntries(items.map((item) => [item.itemKey, item.evidenceAssetRefs]));
      form.setFieldsValue(
        next === "integration"
          ? { integrationItems: selectedItems, integrationEvidence: evidence, integrationEvidenceAssetRefs: evidenceAssetRefs }
          : { acceptanceItems: selectedItems, acceptanceEvidence: evidence, acceptanceEvidenceAssetRefs: evidenceAssetRefs },
      );
    }
    if (next === "video" && onVideoList) {
      try {
        const videos = await onVideoList(row);
        if (request !== detailRequest.current) return;
        setVideoItems(videos);
      } catch (error) {
        if (request !== detailRequest.current) return;
        // Keep the add form usable, but surface that the persisted list could
        // not be read instead of presenting an empty list as fact.
        message.error(error instanceof Error ? error.message : "视频列表读取失败");
      }
    }
    try { await onOpen?.(row, next); }
    finally { if (request === detailRequest.current) setLoadingStep(false); }
  };
  const create = async (values: { companyName?: string }) => {
    if (disabled || readOnly || !onCreate || !values.companyName?.trim()) return;
    setCreating(true);
    try {
      const record = await onCreate(values.companyName.trim());
      setTrainingRowId(undefined);
      const request = ++detailRequest.current;
      uploadTracker.current.beginScope(`${record.id}:profile:${request}`);
      setUploading(false);
      setSelected(record);
      setStep("profile");
      form.resetFields();
      form.setFieldsValue(record);
      createForm.resetFields();
      setShowCreate(false);
      message.success("客户档案已创建");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "客户档案创建失败");
    } finally {
      setCreating(false);
    }
  };
  const save = async (values: Record<string, unknown>) => {
    if (!selected || uploading) return;
    const request = detailRequest.current;
    const next = {
      ...selected,
      ...values,
      profile: step === "profile" ? true : selected.profile,
      integration:
        step === "integration"
          ? ((values.integrationItems as string[]) ?? []).length ===
            INTEGRATION_ITEMS.length
          : selected.integration,
      acceptance:
        step === "acceptance"
          ? ((values.acceptanceItems as string[]) ?? []).length ===
            ACCEPTANCE_ITEMS.length
          : selected.acceptance,
      training:
        step === "training" ? Boolean(values.training) : selected.training,
      videos: selected.videos,
    };
    setSaving(true);
    try {
      let persisted: CustomerDeliveryRecord | void = undefined;
      if (step === "integration" || step === "acceptance") {
        if (!onChecklistSave) throw new Error("客户交付清单保存接口未配置");
        const itemKeys =
          step === "integration" ? INTEGRATION_ITEMS : ACCEPTANCE_ITEMS;
        const selectedItems =
          ((step === "integration"
            ? values.integrationItems
            : values.acceptanceItems) as string[]) ?? [];
        const evidence = (
          step === "integration"
            ? values.integrationEvidence
            : values.acceptanceEvidence
        ) as Record<string, unknown> | undefined;
        const evidenceAssetRefs = (step === "integration" ? values.integrationEvidenceAssetRefs : values.acceptanceEvidenceAssetRefs) as Record<string, unknown> | undefined;
        const items = buildChecklistItems(itemKeys, selectedItems, evidence, evidenceAssetRefs);
        const missing = items.filter((item) => item.completed && item.evidenceAssetRefs.length === 0);
        if (missing.length) throw new Error(`已完成项必须上传凭证：${missing.map((item) => checklistDisplayLabel(item.itemKey)).join("、")}`);
        persisted = await onChecklistSave({
          record: next,
          checklistKey:
            step === "integration"
              ? "system_integration"
              : "functional_acceptance",
          items,
        });
      } else if (step === "training") {
        if (!onTrainingSave) throw new Error("客户培训保存接口未配置");
        const refs = parseCustomerDeliveryEvidenceRefs(values.trainingEvidenceRefs, "培训凭证");
        if (Boolean(values.training) && !refs.length) throw new Error("完成客户培训前请上传培训凭证");
        persisted = await onTrainingSave(selected, Boolean(values.training), refs);
      } else if (step === "video") {
        if (!onVideoAdd) throw new Error("交付视频保存接口未配置");
        const refs = String(values.videoAssetRefs ?? "")
          .split(/[\n,]/u)
          .map((value) => value.trim())
          .filter(Boolean);
        if (!refs.length)
          throw new Error("请填写至少一个已上传视频的 asset_ref");
        for (const [index, assetRef] of refs.entries()) {
          persisted = await onVideoAdd(selected, {
            title: `${selected.companyName} 交付视频 ${selected.videos + index + 1}`,
            assetRef,
            sortOrder: selected.videos + index,
          });
          next.videos = selected.videos + index + 1;
          if (!persisted) next.revision = undefined;
          if (request === detailRequest.current) {
            // Keep only unregistered references so a partial failure is safely
            // retryable without registering earlier successful segments twice.
            form.setFieldValue("videoAssetRefs", refs.slice(index + 1).join("\n"));
            const savedRecord = persisted ?? { ...selected, videos: next.videos, revision: undefined };
            setSelected((current) => current?.id === selected.id ? savedRecord : current);
          }
        }
        if (onVideoList) {
          const videos = await onVideoList(selected);
          if (request === detailRequest.current) setVideoItems(videos);
        }
      } else if (step === "profile") {
        if (!onSave) throw new Error("客户档案保存接口未配置");
        persisted = await onSave(next);
      }
      const finalRecord =
        persisted && typeof persisted === "object" ? persisted : next;
      if (request === detailRequest.current) setSelected((current) => current?.id === selected.id ? finalRecord : current);
      message.success("已保存");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "客户交付保存失败");
      if (step === "video" && onVideoList && request === detailRequest.current) {
        try {
          const videos = await onVideoList(selected);
          if (request === detailRequest.current) {
            setVideoItems(videos);
            // A response can be lost after a successful write. Reconcile
            // persisted references before offering a retry of pending ones.
            const registeredRefs = new Set(videos.map((video) => video.assetRef));
            const remainingRefs = String(form.getFieldValue("videoAssetRefs") ?? "").split(/[\n,]/u).map((value) => value.trim()).filter((value) => value && !registeredRefs.has(value));
            form.setFieldValue("videoAssetRefs", remainingRefs.join("\n"));
          }
        } catch { /* The original save error remains visible; do not replace it. */ }
      }
    } finally {
      setSaving(false);
    }
  };
  const evidenceUpload = (purpose: CustomerDeliveryAssetPurpose, field: string | string[]) => {
    if (!selected || readOnly) return null;
    const scope = `${selected.id}:${step}:${detailRequest.current}`;
    const uploader = JSON.stringify(field);
    return <CustomerDeliveryUpload
      key={`${scope}:${uploader}`}
      purpose={purpose}
      disabled={disabled || loadingStep || saving}
      onUpload={onAssetUpload ? (file, assetPurpose, signal) => onAssetUpload(selected, file, assetPurpose, signal) : undefined}
      onGetAsset={onAssetGet ? (assetRef, assetPurpose, signal) => onAssetGet(selected, assetRef, assetPurpose, signal) : undefined}
      onReady={(asset) => {
        if (!uploadTracker.current.isCurrent(scope)) return;
        if (purpose === "contract") form.setFieldValue(field, asset.assetRef);
        else if (purpose === "video") {
          const refs = String(form.getFieldValue(field) ?? "").split(/[\n,]/u).map((value) => value.trim()).filter(Boolean);
          form.setFieldValue(field, [...new Set([...refs, asset.assetRef])].join("\n"));
        } else appendEvidenceRef(form, field, asset.assetRef);
      }}
      onBusyChange={(busy) => {
        const state = uploadTracker.current.setBusy(scope, uploader, busy);
        if (state !== undefined) setUploading(state);
      }}
    />;
  };
  const confirmTraining = async (row: CustomerDeliveryRecord, completed: boolean, refs: string[]) => {
    if (disabled || readOnly || !onTrainingSave) throw new Error("当前会话没有客户交付修改权限");
    setSaving(true);
    try {
      const updated = await onTrainingSave(row, completed, refs);
      if (updated) setSelected((current) => current?.id === row.id ? updated : current);
      setTrainingRowId((current) => current === row.id ? undefined : current);
      message.success({ key: "customer-delivery-training", content: completed ? "客户培训已完成" : "客户培训已取消" });
    } finally { setSaving(false); }
  };
  const toggleTraining = async (row: CustomerDeliveryRecord, completed: boolean) => {
    if (disabled || readOnly) return;
    const action = customerDeliveryTrainingAction(row, completed);
    if (action === "blocked") { setBlockedCompany(row.companyName); return; }
    if (action === "evidence") { setTrainingRowId(row.id); return; }
    try { await confirmTraining(row, completed, parseCustomerDeliveryEvidenceRefs(row.trainingEvidenceRefs, "培训凭证")); }
    catch (cause) { message.error(cause instanceof Error ? cause.message : "客户培训保存失败"); }
  };
  const columns = useMemo(
    () => [
      {
        title: "序号",
        width: CUSTOMER_DELIVERY_TABLE_WIDTHS.sequence,
        render: (_: unknown, __: CustomerDeliveryRecord, index: number) =>
          String(index + 1).padStart(2, "0"),
      },
      {
        title: "公司名",
        dataIndex: "companyName",
        width: CUSTOMER_DELIVERY_TABLE_WIDTHS.company,
        ellipsis: true,
        render: (value: string) => (
          <Typography.Text strong title={value} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</Typography.Text>
        ),
      },
      ...(["profile", "integration", "acceptance", "training"] as const).map(
        (key) => ({
          title: stepLabels[key],
          dataIndex: key,
          width: CUSTOMER_DELIVERY_TABLE_WIDTHS[key],
          render: (value: boolean, row: CustomerDeliveryRecord) => {
            if (key === "training") return <Space size="small" style={{ whiteSpace: "nowrap" }}>
              <Checkbox checked={value} disabled={disabled || readOnly || saving || !onTrainingSave} onChange={(event) => void toggleTraining(row, event.target.checked)}>{value ? "已完成" : "未完成"}</Checkbox>
              <Button type="link" size="small" disabled={disabled || saving} onClick={() => {
                if (!readOnly && row.paymentStatus !== "paid") setBlockedCompany(row.companyName);
                else setTrainingRowId((current) => current === row.id ? undefined : row.id);
              }}>凭证</Button>
            </Space>;
            return (
              <Button type="link" size="small" disabled={disabled || saving} onClick={() => openStep(row, key)}>
                {value ? <Tag color="success">已完成</Tag> : <Tag>未填写</Tag>}
              </Button>
            );
          },
        }),
      ),
      {
        title: "交付视频",
        dataIndex: "videos",
        width: CUSTOMER_DELIVERY_TABLE_WIDTHS.video,
        render: (value: number, row: CustomerDeliveryRecord) => (
          <Button
            type="link"
            size="small"
            disabled={disabled || saving}
            onClick={() => openStep(row, "video")}
          >
            {value ? `${value} 段` : <Tag>未上传</Tag>}
          </Button>
        ),
      },
      {
        title: "交付完成时间",
        dataIndex: "goLiveAt",
        width: CUSTOMER_DELIVERY_TABLE_WIDTHS.completedAt,
        ellipsis: true,
        render: deliveryCompletionTimeLabel,
      },
      {
        title: "交付状态",
        width: CUSTOMER_DELIVERY_TABLE_WIDTHS.status,
        fixed: "right" as const,
        render: (_: unknown, row: CustomerDeliveryRecord) => {
          const result = deliveryCompletion(row);
          return (
            <Space size={8} style={{ whiteSpace: "nowrap" }}>
              <Progress
                type="circle"
                size={24}
                percent={(result.completed / result.total) * 100}
                showInfo={false}
                status={result.ready ? "success" : "normal"}
              />
              <span>
                {result.ready ? <Tag color="success" style={{ marginInlineEnd: 0 }}>{deliveryStatusLabel(result)}</Tag> : deliveryStatusLabel(result)}
              </span>
            </Space>
          );
        },
      },
    ],
    [onOpen, onTrainingSave, saving, disabled, readOnly],
  );
  return (
    <Card
      title="客户建档"
      extra={
        <Space>
          <Typography.Text type="secondary">
            完成全部交付项后，交付档案才会标记为已完成
          </Typography.Text>
          <Button
            type="primary"
            disabled={disabled || readOnly}
            onClick={() => {
              createForm.resetFields();
              setShowCreate(true);
            }}
          >
            新建客户
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        message="交付状态由各环节真实填写结果决定；未付款客户的系统接入、功能验收和培训入口保持阻断。"
      />
      {blockedCompany ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message="用户尚未完成付款"
          description={`${blockedCompany} 的系统接入、功能测试及培训已阻断；完成付款核验后才可继续。`}
          action={!readOnly ? <Button size="small" onClick={() => { const row = records.find((record) => record.companyName === blockedCompany); if (row) void openStep(row, "profile"); }}>去上传付款凭证</Button> : undefined}
          closable
          onClose={() => setBlockedCompany(undefined)}
        />
      ) : null}
      {showCreate && !readOnly ? (
        <div style={{ marginTop: 12 }}>
          <Card size="small" title="新建客户档案">
            <Form form={createForm} layout="inline" onFinish={create}>
              <Form.Item
                name="companyName"
                label="公司名称"
                rules={[{ required: true, message: "请输入公司名称" }]}
              >
                <Input placeholder="公司名称" />
              </Form.Item>
              <Button htmlType="submit" type="primary" loading={creating}>
                创建
              </Button>
              <Button onClick={() => setShowCreate(false)}>取消</Button>
            </Form>
          </Card>
        </div>
      ) : null}
      <div style={{ marginTop: 16 }}>
        {records.length ? (
          <Table
            rowKey="id"
            size="small"
            tableLayout="fixed"
            scroll={{ x: Object.values(CUSTOMER_DELIVERY_TABLE_WIDTHS).reduce((sum, width) => sum + width, 0) }}
            columns={columns}
            dataSource={records}
            pagination={false}
            expandable={{
              showExpandColumn: false,
              expandedRowKeys: trainingRowId ? [trainingRowId] : [],
              expandedRowRender: (row) => trainingRowId === row.id ? <CustomerDeliveryTrainingEvidence
                key={row.id}
                record={row}
                disabled={disabled || readOnly || saving}
                onUpload={!readOnly && onAssetUpload ? (file, purpose, signal) => onAssetUpload(row, file, purpose, signal) : undefined}
                onGetAsset={onAssetGet ? (assetRef, purpose, signal) => onAssetGet(row, assetRef, purpose, signal) : undefined}
                onConfirm={(refs) => confirmTraining(row, true, refs)}
                onClose={() => setTrainingRowId(undefined)}
              /> : null,
            }}
          />
        ) : (
          <Empty description="暂无客户交付档案；请先创建客户档案" />
        )}
      </div>
      <Drawer
        title={
          selected
            ? `${selected.companyName} · ${stepLabels[step]}`
            : "客户交付详情"
        }
        open={Boolean(selected)}
        onClose={() => { detailRequest.current++; uploadTracker.current.beginScope(); setUploading(false); setLoadingStep(false); setSelected(undefined); }}
        width={560}
      >
        {selected ? (
          <Space orientation="vertical" size="large" style={{ width: "100%" }}>
            <Form
              form={form}
              layout="vertical"
              disabled={disabled || readOnly || loadingStep || saving}
              aria-busy={loadingStep}
              onFinish={save}
            >
              {step === "profile" && (
                <>
                  <Form.Item
                    name="companyName"
                    label="公司名称"
                    rules={[{ required: true, message: "请输入公司名称" }]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    name="contractNo"
                    label="合同编号"
                    rules={[{ required: true, message: "请输入合同编号" }]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    name="paymentStatus"
                    label="付款状态"
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={[
                        { label: "已完成付款核验", value: "paid" },
                        { label: "未支付", value: "unpaid" },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev, cur) =>
                      prev.paymentStatus !== cur.paymentStatus
                    }
                  >
                    {({ getFieldValue }) => (
                      <Form.Item
                        name="paymentDate"
                        label="付款日期"
                        rules={[
                          {
                            required: getFieldValue("paymentStatus") === "paid",
                            message: "已付款客户必须填写付款日期",
                          },
                        ]}
                      >
                        <Input type="date" />
                      </Form.Item>
                    )}
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev, cur) => prev.paymentStatus !== cur.paymentStatus || prev.paymentEvidenceRefs !== cur.paymentEvidenceRefs}
                  >
                    {({ getFieldValue }) => (
                      <Form.Item
                        name="paymentEvidenceRefs"
                        label="付款凭证"
                        rules={[{ validator: async (_, value) => {
                          if (getFieldValue("paymentStatus") !== "paid" || Array.isArray(value) && value.length > 0) return;
                          throw new Error("标记已付款前必须上传付款凭证");
                        } }]}
                      >
                        <Select mode="tags" open={false} placeholder="上传通过安全检查后自动填入" />
                      </Form.Item>
                    )}
                  </Form.Item>
                  {evidenceUpload("payment", "paymentEvidenceRefs")}
                  <Form.Item
                    name="contractFile"
                    label="合同文件"
                    rules={[
                      {
                        required: true,
                        message: "请上传合同文件",
                      },
                      {
                        validator: async (_, value) => {
                          if (
                            typeof value === "string" &&
                            /^asset[:_]/u.test(value.trim())
                          )
                            return;
                          throw new Error(
                            "合同凭据必须上传并通过安全扫描",
                          );
                        },
                      },
                    ]}
                  >
                    <Input placeholder="上传通过安全检查后自动填入" />
                  </Form.Item>
                  <CustomerDeliveryUpload
                    key={`${selected.id}:contract:${detailRequest.current}`}
                    purpose="contract"
                    disabled={loadingStep || saving}
                    onUpload={onAssetUpload ? (file, purpose, signal) => onAssetUpload(selected, file, purpose, signal) : undefined}
                    onGetAsset={onAssetGet ? (assetRef, purpose, signal) => onAssetGet(selected, assetRef, purpose, signal) : undefined}
                    onReady={(asset) => form.setFieldValue("contractFile", asset.assetRef)}
                    onBusyChange={setUploading}
                  />
                  <Typography.Text type="secondary">
                    合同完成仅接受与当前企业工作区和交付记录精确绑定、且安全扫描通过的上传文件。
                  </Typography.Text>
                  <Form.Item
                    name="owner"
                    label="项目负责人"
                    rules={[{ required: true, message: "请输入项目负责人" }]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    name="afterSalesOwner"
                    label="售后负责人"
                    rules={[{ required: true, message: "请输入售后负责人" }]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    name="requiredLaunchAt"
                    label="要求上线时间"
                    rules={[{ required: true, message: "请选择要求上线时间" }]}
                  >
                    <Input type="datetime-local" />
                  </Form.Item>
                </>
              )}
              {step === "integration" && (
                <>
                  <Form.Item name="integrationItems" label="系统接入清单">
                    <Checkbox.Group
                      options={INTEGRATION_ITEMS.map((value) => ({
                        value,
                        label: checklistDisplayLabel(value),
                      }))}
                    />
                  </Form.Item>
                  <Typography.Text type="secondary">每个勾选为已完成的项目都必须上传至少一份凭证；文字说明不能代替文件。</Typography.Text>
                  {INTEGRATION_ITEMS.map((item) => (
                    <Card key={item} size="small" title={checklistDisplayLabel(item)} style={{ marginTop: 12 }}>
                      <Form.Item name={["integrationEvidence", item]} label="凭证说明"><Input placeholder="可选：记录链接、单号或补充说明" /></Form.Item>
                      <Form.Item name={["integrationEvidenceAssetRefs", item]} label="已上传凭证"><Select mode="tags" open={false} placeholder="尚未上传" /></Form.Item>
                      {evidenceUpload("system_integration", ["integrationEvidenceAssetRefs", item])}
                    </Card>
                  ))}
                </>
              )}
              {step === "acceptance" && (
                <>
                  <Form.Item name="acceptanceItems" label="功能测试及验收清单">
                    <Checkbox.Group
                      options={ACCEPTANCE_ITEMS.map((value) => ({
                        value,
                        label: checklistDisplayLabel(value),
                      }))}
                    />
                  </Form.Item>
                  <Typography.Text type="secondary">每个勾选为已完成的项目都必须上传至少一份凭证；文字说明不能代替文件。</Typography.Text>
                  {ACCEPTANCE_ITEMS.map((item) => (
                    <Card key={item} size="small" title={checklistDisplayLabel(item)} style={{ marginTop: 12 }}>
                      <Form.Item name={["acceptanceEvidence", item]} label="凭证说明"><Input placeholder="可选：记录链接、单号或补充说明" /></Form.Item>
                      <Form.Item name={["acceptanceEvidenceAssetRefs", item]} label="已上传凭证"><Select mode="tags" open={false} placeholder="尚未上传" /></Form.Item>
                      {evidenceUpload("functional_acceptance", ["acceptanceEvidenceAssetRefs", item])}
                    </Card>
                  ))}
                </>
              )}
              {step === "training" && (<>
                <Form.Item name="training" valuePropName="checked"><Checkbox>客户培训已完成</Checkbox></Form.Item>
                <Form.Item name="trainingEvidenceRefs" label="已上传培训凭证"><Select mode="tags" open={false} placeholder="上传签到表、培训记录或确认截图" /></Form.Item>
                {evidenceUpload("training", "trainingEvidenceRefs")}
              </>)}
              {step === "video" && (
                <>
                  {videoItems.length ? (
                    <Card size="small" title={`已登记视频（${videoItems.length} 段）`}>
                      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
                        {videoItems
                          .slice()
                          .sort((a, b) => a.sortOrder - b.sortOrder)
                          .map((video) => (
                            <div key={video.id}>
                              <Typography.Text strong>{video.title}</Typography.Text>
                              <Typography.Text type="secondary" style={{ display: "block", wordBreak: "break-all" }}>
                                {video.assetRef}
                              </Typography.Text>
                            </div>
                          ))}
                      </Space>
                    </Card>
                  ) : (
                    <Alert type="info" showIcon message="尚未登记交付视频" description="上传视频或填写已完成安全扫描的素材编号；保存后会显示在这里。" />
                  )}
                  <CustomerDeliveryUpload
                    key={`${selected.id}:video:${detailRequest.current}`}
                    purpose="video"
                    disabled={loadingStep || saving}
                    onUpload={onAssetUpload ? (file, purpose, signal) => onAssetUpload(selected, file, purpose, signal) : undefined}
                    onGetAsset={onAssetGet ? (assetRef, purpose, signal) => onAssetGet(selected, assetRef, purpose, signal) : undefined}
                    onReady={(asset) => {
                      const refs = String(form.getFieldValue("videoAssetRefs") ?? "").split(/[\n,]/u).map((value) => value.trim()).filter(Boolean);
                      form.setFieldValue("videoAssetRefs", [...new Set([...refs, asset.assetRef])].join("\n"));
                    }}
                    onBusyChange={setUploading}
                  />
                  <Form.Item name="videoAssetRefs" label="交付视频（支持多段）">
                    <Input.TextArea
                      rows={4}
                      placeholder="每行一个已上传视频的 asset_ref；支持多段"
                    />
                  </Form.Item>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                    也可手工登记已有视频素材编号；素材须属于当前工作区且已通过可信安全扫描。
                  </Typography.Paragraph>
                </>
              )}
              {!readOnly ? (
                <Button type="primary" htmlType="submit" loading={saving || loadingStep} disabled={uploading}>
                  保存当前环节
                </Button>
              ) : null}
            </Form>
          </Space>
        ) : null}
      </Drawer>
    </Card>
  );
}
