import { useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography,
  message,
} from "antd";
import { deliveryDateTimeInputValue } from "./deliveryDateTime.js";
import { CustomerDeliveryUpload } from "./CustomerDeliveryUpload.js";
import { CustomerDeliveryAccountBinding } from "./CustomerDeliveryAccountBinding.js";
import type {
  CustomerDeliveryAccount,
  CustomerDeliveryAccountPage,
  CustomerDeliveryAsset,
  CustomerDeliveryAssetPurpose,
  CustomerDeliveryUploadSource,
} from "../../api/customerDeliveryClient.js";

export type DeliveryStepKey =
  "profile" | "integration" | "acceptance" | "training";
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
  paymentEvidenceRefs?: string[];
  trainingEvidenceRefs?: string[];
  requiredLaunchAt?: string;
  contractFile?: string;
  integrationItems?: string[];
  acceptanceItems?: string[];
  trainingCompletedAt?: string;
  revision?: number;
  createdAt?: string;
  createdByActorId?: string;
  updatedByActorId?: string;
  targetAccountId?: string | null;
  targetIdentityId?: string | null;
  targetAccountLogin?: string | null;
  /** Per-item evidence returned by the delivery API. Keys are item labels. */
  integrationEvidence?: Record<string, string>;
  acceptanceEvidence?: Record<string, string>;
  integrationEvidenceAssetRefs?: Record<string, string[]>;
  acceptanceEvidenceAssetRefs?: Record<string, string[]>;
}

export interface CustomerDeliveryFilters {
  keyword?: string;
  owner?: string;
  afterSalesOwner?: string;
}

export function filterCustomerDeliveryRecords(
  records: CustomerDeliveryRecord[],
  filters: CustomerDeliveryFilters,
) {
  const keyword = filters.keyword?.trim().toLocaleLowerCase() ?? "";
  return records.filter((record) =>
    (!keyword || record.companyName.toLocaleLowerCase().includes(keyword))
    && (!filters.owner || record.owner === filters.owner)
    && (!filters.afterSalesOwner || record.afterSalesOwner === filters.afterSalesOwner));
}

export interface CustomerDeliveryChecklistItem {
  itemKey: string;
  completed: boolean;
  /** Explicitly empty when an operator confirms an item without audit evidence. */
  evidence: string;
  evidenceAssetRefs: string[];
}

export interface CustomerDeliveryChecklistSave {
  record: CustomerDeliveryRecord;
  checklistKey: "system_integration" | "functional_acceptance";
  items: CustomerDeliveryChecklistItem[];
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
  return itemKeys.map((itemKey) => ({
    itemKey,
    completed: selected.includes(itemKey),
    evidence:
      typeof evidenceMap[itemKey] === "string"
        ? evidenceMap[itemKey].trim()
        : "",
    evidenceAssetRefs: [],
  }));
}

const stepLabels: Record<DeliveryStepKey, string> = {
  profile: "客户档案",
  integration: "系统接入",
  acceptance: "功能测试及验收",
  training: "客户培训",
};

export function isDeliveryStepBlocked(
  _paymentStatus: CustomerDeliveryRecord["paymentStatus"],
  _step: DeliveryStepKey,
) {
  return false;
}

export function deliveryCompletion(record: CustomerDeliveryRecord) {
  const completed = [
    isCustomerProfileFilled(record),
    isDeliveryChecklistComplete(record, "integration"),
    isDeliveryChecklistComplete(record, "acceptance"),
    record.training,
  ].filter(Boolean).length;
  return {
    completed,
    total: 4,
    ready: completed === 4,
  };
}

export function deliveryStatusLabel(result: ReturnType<typeof deliveryCompletion>) {
  return result.ready ? "交付已完成" : `${result.completed}/${result.total}`;
}

export function CustomerDeliveryTrainingEvidence({ record, readOnly = false, disabled = false, onUpload, onGetAsset, onConfirm, onClose }: {
  record: CustomerDeliveryRecord;
  readOnly?: boolean;
  disabled?: boolean;
  onUpload?: (source: CustomerDeliveryUploadSource, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
  onGetAsset?: (assetRef: string, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
  onConfirm: (refs: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [refs, setRefs] = useState<string[]>(record.trainingEvidenceRefs ?? []);
  const [error, setError] = useState("");
  return <section aria-label={`${record.companyName} 客户培训凭证`} style={{ padding: "8px 0" }}>
    <Space style={{ width: "100%", justifyContent: "space-between" }}>
      <Typography.Text strong>客户培训</Typography.Text>
      <Space>
        {!readOnly ? <Button type="primary" disabled={disabled} onClick={() => void onConfirm(refs).catch(cause => setError(cause instanceof Error ? cause.message : "培训确认失败，请重试"))}>确认培训完成</Button> : null}
        <Button aria-label="收起" onClick={onClose}>收起</Button>
      </Space>
    </Space>
    <Input aria-label="已上传培训凭证" value={refs.join("\n")} disabled readOnly placeholder="尚未上传培训凭证" />
    {refs.map(ref => <Typography.Text key={ref} style={{ display: "block", marginTop: 4 }}>{ref}</Typography.Text>)}
    {!readOnly && onUpload && onGetAsset ? <CustomerDeliveryUpload purpose="training" disabled={disabled} onUpload={onUpload} onGetAsset={onGetAsset} onReady={asset => setRefs(current => [...new Set([...current, asset.assetRef])])} /> : null}
    {error ? <Typography.Text type="danger" role="alert">{error}</Typography.Text> : null}
  </section>;
}

export function isCustomerProfileFilled(record: CustomerDeliveryRecord) {
  return record.profile || Boolean(
    record.companyName.trim() &&
    record.contractNo?.trim() &&
    record.paymentDate &&
    record.contractFile?.trim() &&
    record.owner?.trim() &&
    record.afterSalesOwner?.trim(),
  );
}

export function isDeliveryChecklistComplete(record: CustomerDeliveryRecord, key: "integration" | "acceptance") {
  if (record[key]) return true;
  const expected = key === "integration" ? INTEGRATION_ITEMS : ACCEPTANCE_ITEMS;
  const selected = key === "integration" ? record.integrationItems : record.acceptanceItems;
  return Array.isArray(selected) && expected.every((item) => selected.includes(item));
}

export function deliveryLaunchDateLabel(record: Pick<CustomerDeliveryRecord, "createdAt">) {
  const value = record.createdAt;
  if (!value) return "未填写";
  const local = deliveryDateTimeInputValue(value);
  return local ? local.slice(0, 10) : value;
}

export function CustomerDeliverySection({
  readOnly = false,
  disabled = false,
  records = [],
  onOpen,
  onSave,
  onCreate,
  onCreateNavigate,
  onChecklistSave,
  onChecklistLoad,
  onTrainingSave,
  onAssetUpload,
  onAssetGet,
  onAssetOpen,
  onArchive,
  operatorActorId,
  operatorName,
  onAccountList,
  onAccountBind,
}: {
  readOnly?: boolean;
  disabled?: boolean;
  records?: CustomerDeliveryRecord[];
  onOpen?: (
    record: CustomerDeliveryRecord,
    step: DeliveryStepKey,
  ) => Promise<void> | void;
  onSave?: (
    record: CustomerDeliveryRecord,
  ) => Promise<CustomerDeliveryRecord | void> | CustomerDeliveryRecord | void;
  onCreate?: (companyName: string) => Promise<CustomerDeliveryRecord>;
  onCreateNavigate?: () => void;
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
  onAssetUpload?: (record: CustomerDeliveryRecord, source: CustomerDeliveryUploadSource, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
  onAssetGet?: (record: CustomerDeliveryRecord, assetRef: string, purpose: CustomerDeliveryAssetPurpose, signal: AbortSignal) => Promise<CustomerDeliveryAsset>;
  onAssetOpen?: (record: CustomerDeliveryRecord, assetRef: string, purpose: "contract", mode: "open" | "download") => Promise<void>;
  onArchive?: (record: CustomerDeliveryRecord) => Promise<void>;
  operatorActorId?: string;
  operatorName?: string;
  onAccountList?: (input: { search?: string; cursor?: string }, signal: AbortSignal) => Promise<CustomerDeliveryAccountPage>;
  onAccountBind?: (record: CustomerDeliveryRecord, account: CustomerDeliveryAccount, reason: string, signal: AbortSignal) => Promise<CustomerDeliveryRecord>;
}) {
  const [selected, setSelected] = useState<CustomerDeliveryRecord>();
  const [detailsRecord, setDetailsRecord] = useState<CustomerDeliveryRecord>();
  const [step, setStep] = useState<DeliveryStepKey>("profile");
  const [saving, setSaving] = useState(false);
  const [loadingStep, setLoadingStep] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [bindingAccount, setBindingAccount] = useState(false);
  const detailRequest = useRef(0);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [filters, setFilters] = useState<CustomerDeliveryFilters>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [filterForm] = Form.useForm<CustomerDeliveryFilters>();
  const [createForm] = Form.useForm();
  const [form] = Form.useForm();
  const filteredRecords = useMemo(
    () => filterCustomerDeliveryRecords(records ?? [], filters),
    [filters, records],
  );
  const openStep = async (
    row: CustomerDeliveryRecord,
    next: DeliveryStepKey,
  ) => {
    const request = ++detailRequest.current;
    setUploading(false);
    setLoadingStep(true);
    setSelected(row);
    setStep(next);
    form.resetFields();
    form.setFieldsValue({
      ...row,
      integrationItems: row.integrationItems ?? [],
      acceptanceItems: row.acceptanceItems ?? [],
      integrationEvidence: row.integrationEvidence ?? {},
      acceptanceEvidence: row.acceptanceEvidence ?? {},
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
      form.setFieldsValue(
        next === "integration"
          ? { integrationItems: selectedItems, integrationEvidence: evidence }
          : { acceptanceItems: selectedItems, acceptanceEvidence: evidence },
      );
    }
    try { await onOpen?.(row, next); }
    finally { if (request === detailRequest.current) setLoadingStep(false); }
  };
  const create = async (values: { companyName?: string }) => {
    if (!onCreate || !values.companyName?.trim()) return;
    setCreating(true);
    try {
      const record = await onCreate(values.companyName.trim());
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
        const items = buildChecklistItems(itemKeys, selectedItems, evidence);
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
        persisted = await onTrainingSave(selected, Boolean(values.training), []);
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
    } finally {
      setSaving(false);
    }
  };
  const toggleTraining = async (row: CustomerDeliveryRecord, completed: boolean) => {
    if (!onTrainingSave) {
      await openStep(row, "training");
      return;
    }
    setSaving(true);
    try {
      const persisted = await onTrainingSave(row, completed, []);
      if (persisted) setSelected((current) => current?.id === row.id ? persisted : current);
      message.success(completed ? "客户培训已完成" : "客户培训已取消");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "客户培训保存失败");
    } finally {
      setSaving(false);
    }
  };
  const openDetails = async (row: CustomerDeliveryRecord) => {
    setDetailsRecord(row);
  };
  const columns = useMemo(
    () => [
      {
        title: "序号",
        width: 48,
        align: "center" as const,
        render: (_: unknown, __: CustomerDeliveryRecord, index: number) =>
          String(index + 1).padStart(2, "0"),
      },
      {
        title: "公司名",
        width: 190,
        align: "center" as const,
        dataIndex: "companyName",
        render: (value: string) => (
          <Typography.Text strong>{value}</Typography.Text>
        ),
      },
      ...(["profile", "integration", "acceptance"] as const).map(
        (key) => ({
          title: stepLabels[key],
          width: key === "acceptance" ? 120 : key === "profile" ? 76 : 86,
          align: "center" as const,
          dataIndex: key,
          render: (_value: boolean, row: CustomerDeliveryRecord) => {
            const value = key === "profile" ? isCustomerProfileFilled(row) : isDeliveryChecklistComplete(row, key);
            const label = value ? "已完成" : "未完成";
            return <Button type="link" size="small" onClick={() => void openStep(row, key)}>{label}</Button>;
          },
        }),
      ),
      {
        title: "客户培训",
        width: 108,
        align: "center" as const,
        dataIndex: "training",
        render: (value: boolean, row: CustomerDeliveryRecord) => (
          <Select
            size="small"
            aria-label={`${row.companyName}客户培训状态`}
            value={value ? "trained" : "untrained"}
            disabled={saving || !onTrainingSave}
            style={{ width: 94 }}
            options={[
              { value: "trained", label: "已培训" },
              { value: "untrained", label: "未培训" },
            ]}
            onChange={(next) => void toggleTraining(row, next === "trained")}
          />
        ),
      },
      {
        title: "上线时间",
        width: 110,
        align: "center" as const,
        render: (_: unknown, row: CustomerDeliveryRecord) => deliveryLaunchDateLabel(row),
      },
      {
        title: "销售负责人",
        width: 110,
        align: "center" as const,
        dataIndex: "owner",
        render: (value?: string) => value?.trim() || "-",
      },
      {
        title: "售后负责人",
        width: 110,
        align: "center" as const,
        dataIndex: "afterSalesOwner",
        render: (value?: string) => value?.trim() || "-",
      },
      {
        title: "操作",
        width: 92,
        align: "center" as const,
        fixed: "right" as const,
        render: (_: unknown, row: CustomerDeliveryRecord) => (
          <Button size="small" onClick={() => void openDetails(row)}>查看详情</Button>
        ),
      },
    ],
    [onTrainingSave, openStep, saving],
  );
  return (
    <Card
      title="客户建档"
      extra={
        <Space>
          <Button
            type="primary"
            disabled={disabled}
            onClick={() => {
              if (onCreateNavigate) { onCreateNavigate(); return; }
              createForm.resetFields();
              setShowCreate(true);
            }}
          >
            新建客户
          </Button>
        </Space>
      }
    >
      <Drawer
        title="新建客户档案"
        open={showCreate}
        onClose={() => setShowCreate(false)}
        size={480}
        extra={<Button type="primary" loading={creating} onClick={() => createForm.submit()}>创建</Button>}
      >
        <Form form={createForm} layout="vertical" onFinish={create}>
          <Form.Item
            name="companyName"
            label="公司名称"
            rules={[{ required: true, message: "请输入公司名称" }]}
          >
            <Input placeholder="请输入公司名称" autoFocus />
          </Form.Item>
        </Form>
      </Drawer>
      <Form
        form={filterForm}
        className="customer-delivery-filter-form"
        layout="inline"
        style={{ marginBottom: 16, rowGap: 12 }}
        onFinish={(values) => {
          setFilters({
            keyword: values.keyword?.trim(),
            owner: values.owner,
            afterSalesOwner: values.afterSalesOwner,
          });
          setCurrentPage(1);
        }}
      >
        <Form.Item name="keyword" label="搜索">
          <Input allowClear aria-label="按公司名搜索" placeholder="请输入公司名" style={{ width: 220 }} />
        </Form.Item>
        <Form.Item name="owner" label="销售负责人">
          <Select
            allowClear
            aria-label="销售负责人筛选"
            placeholder="请选择"
            style={{ width: 140 }}
            options={["姜伟", "韩先晓", "李风"].map((value) => ({ value, label: value }))}
          />
        </Form.Item>
        <Form.Item name="afterSalesOwner" label="售后负责人">
          <Select
            allowClear
            aria-label="售后负责人筛选"
            placeholder="请选择"
            style={{ width: 140 }}
            options={["姜伟", "韩先晓"].map((value) => ({ value, label: value }))}
          />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit">查询</Button>
        </Form.Item>
      </Form>
      <div style={{ marginTop: 0 }}>
        <Table
          rowKey="id"
          size="small"
          scroll={{ x: 1140 }}
          tableLayout="fixed"
          columns={columns}
          dataSource={filteredRecords}
          pagination={{
            current: currentPage,
            pageSize: 10,
            showSizeChanger: false,
            placement: ["bottomCenter"],
            onChange: setCurrentPage,
          }}
          locale={{
            emptyText: (records?.length ?? 0) > 0
              ? "没有符合筛选条件的客户"
              : "暂无客户交付档案；请先创建客户档案",
          }}
        />
      </div>
      <Drawer
        title={detailsRecord ? `${detailsRecord.companyName} · 客户详情` : "客户详情"}
        open={Boolean(detailsRecord)}
        onClose={() => setDetailsRecord(undefined)}
        size={620}
      >
        {detailsRecord ? (
          <>
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="公司名称">{detailsRecord.companyName}</Descriptions.Item>
            <Descriptions.Item label="合同编号">{detailsRecord.contractNo || "未填写"}</Descriptions.Item>
            <Descriptions.Item label="付款形式">{detailsRecord.paymentStatus === "paid" ? "接入费" : "赠送"}</Descriptions.Item>
            <Descriptions.Item label="付款时间">{detailsRecord.paymentDate || "未填写"}</Descriptions.Item>
            <Descriptions.Item label="合同文件">{detailsRecord.contractFile ? <Space wrap><Typography.Link style={{ wordBreak: "break-all" }} onClick={() => void onAssetOpen?.(detailsRecord, detailsRecord.contractFile!, "contract", "open")}>{detailsRecord.contractFile}</Typography.Link><Button size="small" onClick={() => void onAssetOpen?.(detailsRecord, detailsRecord.contractFile!, "contract", "download")}>下载</Button></Space> : "未上传"}</Descriptions.Item>
            <Descriptions.Item label="系统接入">{isDeliveryChecklistComplete(detailsRecord, "integration") ? "已完成" : "未完成"}</Descriptions.Item>
            <Descriptions.Item label="功能测试及验收">{isDeliveryChecklistComplete(detailsRecord, "acceptance") ? "已完成" : "未完成"}</Descriptions.Item>
            <Descriptions.Item label="客户培训">{detailsRecord.training ? "已培训" : "未培训"}</Descriptions.Item>
            <Descriptions.Item label="销售负责人">{detailsRecord.owner || "未填写"}</Descriptions.Item>
            <Descriptions.Item label="售后负责人">{detailsRecord.afterSalesOwner || "未填写"}</Descriptions.Item>
            <Descriptions.Item label="上线时间">{deliveryLaunchDateLabel(detailsRecord)}</Descriptions.Item>
            <Descriptions.Item label="操作人">
              {detailsRecord.updatedByActorId === operatorActorId
                ? operatorName || "账号名称未提供"
                : detailsRecord.updatedByActorId || "未记录"}
            </Descriptions.Item>
          </Descriptions>
          <CustomerDeliveryTrainingEvidence
            record={detailsRecord}
            readOnly={readOnly || !onTrainingSave}
            disabled={disabled || saving || uploading}
            onUpload={onAssetUpload ? (source, purpose, signal) => onAssetUpload(detailsRecord, source, purpose, signal) : undefined}
            onGetAsset={onAssetGet ? (assetRef, purpose, signal) => onAssetGet(detailsRecord, assetRef, purpose, signal) : undefined}
            onConfirm={async refs => {
              if (!onTrainingSave) return;
              const saved = await onTrainingSave(detailsRecord, true, refs);
              if (saved) setDetailsRecord(saved);
            }}
            onClose={() => setDetailsRecord(undefined)}
          />
          </>
        ) : null}
        {detailsRecord && onArchive ? <div style={{ marginTop: 24, textAlign: "right" }}><Button danger onClick={() => Modal.confirm({ title: `停用并删除“${detailsRecord.companyName}”记录？`, content: "该记录会从当前列表移除，但业务数据会保留，管理员仍可恢复。", okText: "确认停用并删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: async () => { await onArchive(detailsRecord); setDetailsRecord(undefined); message.success("记录已停用并从列表移除"); } })}>停用并删除记录</Button></div> : null}
      </Drawer>
      <Drawer
        title={
          selected
            ? `${selected.companyName} · ${stepLabels[step]}`
            : "客户交付详情"
        }
        open={Boolean(selected)}
        onClose={() => { detailRequest.current++; setLoadingStep(false); setSelected(undefined); }}
        size={560}
      >
        {selected ? (
          <Space orientation="vertical" size="large" style={{ width: "100%" }}>
            {step === "profile" ? <CustomerDeliveryAccountBinding
              key={`${selected.id}:${detailRequest.current}`}
              record={selected}
              readOnly={!onAccountBind}
              disabled={readOnly || disabled || loadingStep || saving || uploading}
              onList={onAccountList}
              onBind={onAccountBind}
              onBusyChange={setBindingAccount}
              onBound={(record) => {
                setSelected((current) => current?.id === record.id ? {
                  ...current,
                  targetAccountId: record.targetAccountId,
                  targetIdentityId: record.targetIdentityId,
                  targetAccountLogin: record.targetAccountLogin,
                  revision: record.revision,
                } : current);
                form.setFieldValue("revision", record.revision);
              }}
            /> : null}
            <Form
              form={form}
              layout="vertical"
              disabled={readOnly || loadingStep || saving || bindingAccount}
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
                    name="contractFile"
                    label="合同文件"
                    rules={[
                      {
                        required: true,
                        message: "请填写合同 asset_ref 或 HTTPS 链接",
                      },
                      {
                        validator: async (_, value) => {
                          if (
                            typeof value === "string" &&
                            (/^https:\/\//u.test(value.trim()) ||
                              /^asset[:_]/u.test(value.trim()))
                          )
                            return;
                          throw new Error(
                            "合同必须是 HTTPS 链接或已扫描的 asset_ref",
                          );
                        },
                      },
                    ]}
                  >
                    <Input placeholder="asset_ref 或 https://... 合同链接" />
                  </Form.Item>
                  <CustomerDeliveryUpload
                    key={`${selected.id}:contract:${detailRequest.current}`}
                    purpose="contract"
                    disabled={readOnly || loadingStep || saving}
                    onUpload={onAssetUpload ? (file, purpose, signal) => onAssetUpload(selected, file, purpose, signal) : undefined}
                    onGetAsset={onAssetGet ? (assetRef, purpose, signal) => onAssetGet(selected, assetRef, purpose, signal) : undefined}
                    onReady={(asset) => form.setFieldValue("contractFile", asset.assetRef)}
                    onBusyChange={setUploading}
                  />
                  <Typography.Text type="secondary">
                    素材编号须通过服务端安全核验；HTTPS 链接作为外部合同凭证保存，不代表已完成平台扫描。
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
                  <Typography.Text type="secondary">
                    为已完成项填写证据（链接、截图说明或记录编号）。
                  </Typography.Text>
                  {INTEGRATION_ITEMS.map((item) => (
                    <Form.Item
                      key={item}
                      name={["integrationEvidence", item]}
                      label={`${checklistDisplayLabel(item)} · 证据`}
                    >
                      <Input placeholder="可填写链接、截图说明或记录编号" />
                    </Form.Item>
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
                  <Typography.Text type="secondary">
                    为已完成项填写证据（链接、截图说明或记录编号）。
                  </Typography.Text>
                  {ACCEPTANCE_ITEMS.map((item) => (
                    <Form.Item
                      key={item}
                      name={["acceptanceEvidence", item]}
                      label={`${checklistDisplayLabel(item)} · 证据`}
                    >
                      <Input placeholder="可填写链接、截图说明或记录编号" />
                    </Form.Item>
                  ))}
                </>
              )}
              {step === "training" && (
                <Form.Item name="training" valuePropName="checked">
                  <Checkbox>客户培训已完成（独立记录培训结果）</Checkbox>
                </Form.Item>
              )}
              {!readOnly ? <Button type="primary" htmlType="submit" loading={saving || loadingStep} disabled={uploading}>
                保存当前环节
              </Button> : null}
            </Form>
          </Space>
        ) : null}
      </Drawer>
    </Card>
  );
}
