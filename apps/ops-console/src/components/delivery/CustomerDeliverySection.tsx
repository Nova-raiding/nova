import { useMemo, useState } from "react";
import { Alert, Button, Card, Checkbox, Descriptions, Drawer, Empty, Form, Input, Progress, Select, Space, Steps, Table, Tag, Typography, Upload, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";

export type DeliveryStepKey = "profile" | "integration" | "acceptance" | "training" | "video";
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
}

export const INTEGRATION_ITEMS = ["插件账号", "店铺连接", "商品扫描", "知识库", "平台规则", "创意点数", "企业信息", "品牌资产", "商品资料", "客户偏好"];
export const ACCEPTANCE_ITEMS = ["文案生成", "图片生成", "标注编辑", "自动检查", "视频生成", "店铺/商品读取", "技术验收", "内容验收"];

const stepLabels: Record<DeliveryStepKey, string> = {
  profile: "客户档案", integration: "系统接入", acceptance: "功能测试及验收", training: "客户培训", video: "交付视频",
};

export function deliveryCompletion(record: CustomerDeliveryRecord) {
  const completed = [record.profile, record.integration, record.acceptance, record.training, record.videos > 0].filter(Boolean).length;
  // Payment is a prerequisite for activation. The UI gate prevents unpaid
  // operators from entering controlled steps, but the aggregate must also be
  // fail-closed when data is imported or updated through another route.
  return { completed, total: 5, ready: record.paymentStatus === "paid" && completed === 5 };
}

export function CustomerDeliverySection({ records = [], onOpen, onSave }: { records?: CustomerDeliveryRecord[]; onOpen?: (record: CustomerDeliveryRecord, step: DeliveryStepKey) => void; onSave?: (record: CustomerDeliveryRecord) => Promise<void> | void }) {
  const [selected, setSelected] = useState<CustomerDeliveryRecord>();
  const [step, setStep] = useState<DeliveryStepKey>("profile");
  const [blockedCompany, setBlockedCompany] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const openStep = (row: CustomerDeliveryRecord, next: DeliveryStepKey) => {
    if (row.paymentStatus !== "paid" && ["integration", "acceptance", "training"].includes(next)) {
      setBlockedCompany(row.companyName);
      return;
    }
    setBlockedCompany(undefined);
    setSelected(row); setStep(next); form.setFieldsValue(row); onOpen?.(row, next);
  };
  const save = async (values: Record<string, unknown>) => {
    if (!selected) return;
    const next = { ...selected, ...values,
      profile: step === "profile" ? true : selected.profile,
      integration: step === "integration" ? (values.integrationItems as string[] ?? []).length === INTEGRATION_ITEMS.length : selected.integration,
      acceptance: step === "acceptance" ? (values.acceptanceItems as string[] ?? []).length === ACCEPTANCE_ITEMS.length : selected.acceptance,
      training: step === "training" ? Boolean(values.training) : selected.training,
      videos: step === "video" ? ((values.videoUrls as string[] ?? []).length) : selected.videos };
    setSaving(true); try { await onSave?.(next); setSelected(next); message.success("已保存"); } finally { setSaving(false); }
  };
  const columns = useMemo(() => [
    { title: "序号", width: 72, render: (_: unknown, __: CustomerDeliveryRecord, index: number) => String(index + 1).padStart(2, "0") },
    { title: "公司名", dataIndex: "companyName", render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    ...(["profile", "integration", "acceptance", "training"] as const).map((key) => ({ title: stepLabels[key], dataIndex: key, render: (value: boolean, row: CustomerDeliveryRecord) => <Button type="link" size="small" onClick={() => openStep(row, key)}>{value ? <Tag color="success">已完成</Tag> : <Tag>未填写</Tag>}</Button> })),
    { title: "交付视频", dataIndex: "videos", render: (value: number, row: CustomerDeliveryRecord) => <Button type="link" size="small" onClick={() => openStep(row, "video")}>{value ? `${value} 段` : <Tag>未上传</Tag>}</Button> },
    { title: "上线时间", dataIndex: "goLiveAt", render: (value?: string) => value || "系统生成" },
    { title: "交付状态", render: (_: unknown, row: CustomerDeliveryRecord) => { const result = deliveryCompletion(row); return <Space><Progress type="circle" size={28} percent={result.completed / result.total * 100} showInfo={false} status={result.ready ? "success" : "normal"} /><span>{result.ready ? <Tag color="success">已生效</Tag> : `${result.completed}/${result.total}`}</span></Space>; } },
  ], [onOpen]);
  return <Card title="客户建档" extra={<Typography.Text type="secondary">完成全部交付项后，客户主体才会变为生效</Typography.Text>}>
    <Alert type="info" showIcon message="交付状态由各环节真实填写结果决定；未付款客户的系统接入、功能验收和培训入口保持阻断。" />
    {blockedCompany ? <Alert style={{ marginTop: 12 }} type="warning" showIcon message="用户尚未完成付款" description={`${blockedCompany} 的系统接入、功能测试及培训已阻断；完成付款核验后才可继续。`} closable onClose={() => setBlockedCompany(undefined)} /> : null}
    <div style={{ marginTop: 16 }}>{records.length ? <Table rowKey="id" size="small" scroll={{ x: 1180 }} columns={columns} dataSource={records} pagination={false} /> : <Empty description="暂无客户交付档案；请先创建客户档案" />}</div>
    <Drawer title={selected ? `${selected.companyName} · ${stepLabels[step]}` : "客户交付详情"} open={Boolean(selected)} onClose={() => setSelected(undefined)} width={560}>
      {selected ? <Space orientation="vertical" size="large" style={{ width: "100%" }}><Steps current={Object.keys(stepLabels).indexOf(step)} items={Object.values(stepLabels).map((title, index) => ({ title, status: index < deliveryCompletion(selected).completed ? "finish" : index === Object.keys(stepLabels).indexOf(step) ? "process" : "wait" }))} />
        <Form form={form} layout="vertical" onFinish={save} initialValues={selected}>
          {step === "profile" && <><Form.Item name="companyName" label="公司名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="contractNo" label="合同编号"><Input /></Form.Item><Form.Item name="paymentStatus" label="付款状态"><Select options={[{ label: "已完成付款核验", value: "paid" }, { label: "未支付", value: "unpaid" }]} /></Form.Item><Form.Item name="paymentDate" label="付款日期"><Input type="date" /></Form.Item><Form.Item name="contractFile" label="合同文件"><Upload beforeUpload={() => false} maxCount={1}><Button>上传合同</Button></Upload></Form.Item><Form.Item name="owner" label="项目负责人"><Input /></Form.Item><Form.Item name="afterSalesOwner" label="售后负责人"><Input /></Form.Item><Form.Item name="requiredLaunchAt" label="要求上线时间"><Input type="datetime-local" /></Form.Item></>}
          {step === "integration" && <Form.Item name="integrationItems" label="系统接入清单"><Checkbox.Group options={INTEGRATION_ITEMS} /></Form.Item>}
          {step === "acceptance" && <Form.Item name="acceptanceItems" label="功能测试及验收清单"><Checkbox.Group options={ACCEPTANCE_ITEMS} /></Form.Item>}
          {step === "training" && <Form.Item name="training" valuePropName="checked"><Checkbox>客户培训已完成（与功能验收结果同步记录）</Checkbox></Form.Item>}
          {step === "video" && <Form.Item name="videoUrls" label="交付视频（支持多段）"><Upload multiple beforeUpload={() => false} listType="text"><Button icon={<PlusOutlined />}>选择视频</Button></Upload></Form.Item>}
          <Button type="primary" htmlType="submit" loading={saving}>保存当前环节</Button>
        </Form>
      </Space> : null}
    </Drawer>
  </Card>;
}
