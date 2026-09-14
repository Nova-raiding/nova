import { useMemo, useState } from "react";
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
  Steps,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";

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
  integrationItems?: string[];
  acceptanceItems?: string[];
  trainingCompletedAt?: string;
  videoUrls?: string[];
  revision?: number;
  /** Per-item evidence returned by the delivery API. Keys are item labels. */
  integrationEvidence?: Record<string, string>;
  acceptanceEvidence?: Record<string, string>;
}

export interface CustomerDeliveryChecklistItem {
  itemKey: string;
  completed: boolean;
  /** Explicitly empty when an item has no evidence yet; the API may reject it. */
  evidence: string;
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
  }));
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
  // Payment is a prerequisite for activation. The UI gate prevents unpaid
  // operators from entering controlled steps, but the aggregate must also be
  // fail-closed when data is imported or updated through another route.
  return {
    completed,
    total: 5,
    ready: record.paymentStatus === "paid" && completed === 5,
  };
}

export function CustomerDeliverySection({
  records = [],
  onOpen,
  onSave,
  onCreate,
  onChecklistSave,
  onChecklistLoad,
  onTrainingSave,
  onVideoAdd,
  onVideoList,
}: {
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
  ) => Promise<CustomerDeliveryRecord | void>;
  onVideoAdd?: (
    record: CustomerDeliveryRecord,
    input: { title: string; assetRef: string; sortOrder: number },
  ) => Promise<CustomerDeliveryRecord | void>;
  /** Load persisted segments when opening the video step. */
  onVideoList?: (
    record: CustomerDeliveryRecord,
  ) => Promise<CustomerDeliveryVideoItem[]>;
}) {
  const [selected, setSelected] = useState<CustomerDeliveryRecord>();
  const [step, setStep] = useState<DeliveryStepKey>("profile");
  const [blockedCompany, setBlockedCompany] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [videoItems, setVideoItems] = useState<CustomerDeliveryVideoItem[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm] = Form.useForm();
  const [form] = Form.useForm();
  const openStep = async (
    row: CustomerDeliveryRecord,
    next: DeliveryStepKey,
  ) => {
    if (isDeliveryStepBlocked(row.paymentStatus, next)) {
      setBlockedCompany(row.companyName);
      return;
    }
    setBlockedCompany(undefined);
    setSelected(row);
    setStep(next);
    setVideoItems([]);
    form.setFieldsValue({
      ...row,
      requiredLaunchAt: row.requiredLaunchAt
        ? row.requiredLaunchAt.slice(0, 16)
        : undefined,
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
        setSelected(undefined);
        message.error(error instanceof Error ? error.message : "清单读取失败");
        return;
      }
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
    if (next === "video" && onVideoList) {
      try {
        setVideoItems(await onVideoList(row));
      } catch (error) {
        // Keep the add form usable, but surface that the persisted list could
        // not be read instead of presenting an empty list as fact.
        message.error(error instanceof Error ? error.message : "视频列表读取失败");
      }
    }
    await onOpen?.(row, next);
  };
  const create = async (values: { companyName?: string }) => {
    if (!onCreate || !values.companyName?.trim()) return;
    setCreating(true);
    try {
      const record = await onCreate(values.companyName.trim());
      setSelected(record);
      setStep("profile");
      form.setFieldsValue(record);
      createForm.resetFields();
      message.success("客户档案已创建");
    } finally {
      setCreating(false);
    }
  };
  const save = async (values: Record<string, unknown>) => {
    if (!selected) return;
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
      videos:
        step === "video"
          ? ((values.videoUrls as string[]) ?? []).length
          : selected.videos,
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
        persisted = await onTrainingSave(selected, Boolean(values.training));
      } else if (step === "video") {
        if (!onVideoAdd) throw new Error("交付视频保存接口未配置");
        const refs = String(values.videoAssetRefs ?? "")
          .split(/[\n,]/u)
          .map((value) => value.trim())
          .filter(Boolean);
        if (!refs.length)
          throw new Error("请填写至少一个已上传视频的 asset_ref");
        for (const [index, assetRef] of refs.entries())
          persisted = await onVideoAdd(selected, {
            title: `${selected.companyName} 交付视频 ${selected.videos + index + 1}`,
            assetRef,
            sortOrder: selected.videos + index,
          });
        if (onVideoList) setVideoItems(await onVideoList(selected));
      } else if (step === "profile") {
        if (!onSave) throw new Error("客户档案保存接口未配置");
        persisted = await onSave(next);
      }
      const finalRecord =
        persisted && typeof persisted === "object" ? persisted : next;
      setSelected(finalRecord);
      message.success("已保存");
    } finally {
      setSaving(false);
    }
  };
  const toggleTraining = async (row: CustomerDeliveryRecord, completed: boolean) => {
    if (!onTrainingSave) {
      await openStep(row, "training");
      return;
    }
    if (isDeliveryStepBlocked(row.paymentStatus, "training")) {
      setBlockedCompany(row.companyName);
      return;
    }
    setSaving(true);
    try {
      const persisted = await onTrainingSave(row, completed);
      if (persisted) setSelected(persisted);
      message.success(completed ? "客户培训已完成" : "客户培训已取消");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "客户培训保存失败");
    } finally {
      setSaving(false);
    }
  };
  const columns = useMemo(
    () => [
      {
        title: "序号",
        width: 72,
        render: (_: unknown, __: CustomerDeliveryRecord, index: number) =>
          String(index + 1).padStart(2, "0"),
      },
      {
        title: "公司名",
        dataIndex: "companyName",
        render: (value: string) => (
          <Typography.Text strong>{value}</Typography.Text>
        ),
      },
      ...(["profile", "integration", "acceptance", "training"] as const).map(
        (key) => ({
          title: stepLabels[key],
          dataIndex: key,
          render: (value: boolean, row: CustomerDeliveryRecord) => {
            if (key === "training" && onTrainingSave && row.paymentStatus === "paid") {
              return (
                <Space size="small">
                  <Checkbox
                    checked={value}
                    disabled={saving}
                    onChange={(event) => void toggleTraining(row, event.target.checked)}
                  >
                    {value ? "已完成" : "未完成"}
                  </Checkbox>
                  <Button type="link" size="small" onClick={() => openStep(row, key)}>
                    详情
                  </Button>
                </Space>
              );
            }
            return (
              <Button type="link" size="small" onClick={() => openStep(row, key)}>
                {value ? <Tag color="success">已完成</Tag> : <Tag>{key === "training" ? "未完成" : "未填写"}</Tag>}
              </Button>
            );
          },
        }),
      ),
      {
        title: "交付视频",
        dataIndex: "videos",
        render: (value: number, row: CustomerDeliveryRecord) => (
          <Button
            type="link"
            size="small"
            onClick={() => openStep(row, "video")}
          >
            {value ? `${value} 段` : <Tag>未上传</Tag>}
          </Button>
        ),
      },
      {
        title: "上线时间",
        dataIndex: "goLiveAt",
        render: (value?: string) => value || "系统生成",
      },
      {
        title: "交付状态",
        render: (_: unknown, row: CustomerDeliveryRecord) => {
          const result = deliveryCompletion(row);
          return (
            <Space>
              <Progress
                type="circle"
                size={28}
                percent={(result.completed / result.total) * 100}
                showInfo={false}
                status={result.ready ? "success" : "normal"}
              />
              <span>
                {result.ready ? (
                  <Tag color="success">已生效</Tag>
                ) : (
                  `${result.completed}/${result.total}`
                )}
              </span>
            </Space>
          );
        },
      },
    ],
    [onOpen, onTrainingSave, saving],
  );
  return (
    <Card
      title="客户建档"
      extra={
        <Space>
          <Typography.Text type="secondary">
            完成全部交付项后，客户主体才会变为生效
          </Typography.Text>
          <Button
            type="primary"
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
          closable
          onClose={() => setBlockedCompany(undefined)}
        />
      ) : null}
      {showCreate ? (
        <div style={{ marginTop: 12 }}>
          <Card size="small" title="新建客户档案">
            <Form form={createForm} layout="inline" onFinish={create}>
              <Form.Item
                name="companyName"
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
            scroll={{ x: 1180 }}
            columns={columns}
            dataSource={records}
            pagination={false}
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
        onClose={() => setSelected(undefined)}
        width={560}
      >
        {selected ? (
          <Space orientation="vertical" size="large" style={{ width: "100%" }}>
            <Steps
              current={Object.keys(stepLabels).indexOf(step)}
              items={Object.values(stepLabels).map((title, index) => {
                const key = Object.keys(stepLabels)[index] as DeliveryStepKey;
                const complete =
                  key === "video" ? selected.videos > 0 : selected[key];
                return {
                  title,
                  status: complete
                    ? "finish"
                    : index === Object.keys(stepLabels).indexOf(step)
                      ? "process"
                      : "wait",
                };
              })}
            />
            <Form
              form={form}
              layout="vertical"
              onFinish={save}
              initialValues={selected}
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
                  <Typography.Text type="secondary">
                    合同文件请先通过素材中心安全上传；此处只保存已验证的
                    asset_ref/HTTPS 链接。
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
                    <Alert type="info" showIcon message="尚未登记交付视频" description="请填写已完成安全扫描的 asset_ref；保存后会显示在这里。" />
                  )}
                  <Form.Item name="videoAssetRefs" label="交付视频（支持多段）">
                    <Input.TextArea
                      rows={4}
                      placeholder="每行一个已上传视频的 asset_ref；支持多段"
                    />
                  </Form.Item>
                  <Typography.Text type="secondary">
                    视频必须先通过素材中心安全上传并完成扫描，再填写
                    asset_ref。页面不会把本地选文件误报为已上传。
                  </Typography.Text>
                  <Upload
                    beforeUpload={() => {
                      message.info(
                        "请先通过素材中心安全上传，再填写 asset_ref",
                      );
                      return Upload.LIST_IGNORE;
                    }}
                    showUploadList={false}
                  >
                    <Button icon={<PlusOutlined />}>
                      选择视频（需安全上传）
                    </Button>
                  </Upload>
                </>
              )}
              <Button type="primary" htmlType="submit" loading={saving}>
                保存当前环节
              </Button>
            </Form>
          </Space>
        ) : null}
      </Drawer>
    </Card>
  );
}
