import { useMemo, useState } from "react";
import { Alert, Button, Card, Descriptions, Drawer, Empty, Progress, Space, Steps, Table, Tag, Typography } from "antd";

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
}

const stepLabels: Record<DeliveryStepKey, string> = {
  profile: "客户档案", integration: "系统接入", acceptance: "功能测试及验收", training: "客户培训", video: "交付视频",
};

export function deliveryCompletion(record: CustomerDeliveryRecord) {
  const completed = [record.profile, record.integration, record.acceptance, record.training, record.videos > 0].filter(Boolean).length;
  return { completed, total: 5, ready: completed === 5 };
}

export function CustomerDeliverySection({ records = [], onOpen }: { records?: CustomerDeliveryRecord[]; onOpen?: (record: CustomerDeliveryRecord, step: DeliveryStepKey) => void }) {
  const [selected, setSelected] = useState<CustomerDeliveryRecord>();
  const [step, setStep] = useState<DeliveryStepKey>("profile");
  const columns = useMemo(() => [
    { title: "序号", width: 72, render: (_: unknown, __: CustomerDeliveryRecord, index: number) => String(index + 1).padStart(2, "0") },
    { title: "公司名", dataIndex: "companyName", render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    ...(["profile", "integration", "acceptance", "training"] as const).map((key) => ({ title: stepLabels[key], dataIndex: key, render: (value: boolean, row: CustomerDeliveryRecord) => <Button type="link" size="small" onClick={() => { setSelected(row); setStep(key); onOpen?.(row, key); }}>{value ? <Tag color="success">已完成</Tag> : <Tag>未填写</Tag>}</Button> })),
    { title: "交付视频", dataIndex: "videos", render: (value: number, row: CustomerDeliveryRecord) => <Button type="link" size="small" onClick={() => { setSelected(row); setStep("video"); onOpen?.(row, "video"); }}>{value ? `${value} 段` : <Tag>未上传</Tag>}</Button> },
    { title: "上线时间", dataIndex: "goLiveAt", render: (value?: string) => value || "系统生成" },
    { title: "交付状态", render: (_: unknown, row: CustomerDeliveryRecord) => { const result = deliveryCompletion(row); return <Space><Progress type="circle" size={28} percent={result.completed / result.total * 100} showInfo={false} status={result.ready ? "success" : "normal"} /><span>{result.ready ? <Tag color="success">已生效</Tag> : `${result.completed}/${result.total}`}</span></Space>; } },
  ], [onOpen]);
  return <Card title="客户建档" extra={<Typography.Text type="secondary">完成全部交付项后，客户主体才会变为生效</Typography.Text>}>
    <Alert type="info" showIcon message="交付状态由各环节真实填写结果决定；未付款客户的系统接入、功能验收和培训入口保持阻断。" />
    <div style={{ marginTop: 16 }}>{records.length ? <Table rowKey="id" size="small" scroll={{ x: 1180 }} columns={columns} dataSource={records} pagination={false} /> : <Empty description="暂无客户交付档案；请先创建客户档案" />}</div>
    <Drawer title={selected ? `${selected.companyName} · ${stepLabels[step]}` : "客户交付详情"} open={Boolean(selected)} onClose={() => setSelected(undefined)} width={560}>
      {selected ? <Space orientation="vertical" size="large" style={{ width: "100%" }}><Steps current={Object.keys(stepLabels).indexOf(step)} items={Object.values(stepLabels).map((title, index) => ({ title, status: index < deliveryCompletion(selected).completed ? "finish" : index === Object.keys(stepLabels).indexOf(step) ? "process" : "wait" }))} /><Descriptions column={1} bordered size="small"><Descriptions.Item label="合同编号">{selected.contractNo || "未填写"}</Descriptions.Item><Descriptions.Item label="付款状态">{selected.paymentStatus === "paid" ? <Tag color="success">已支付</Tag> : <Tag color="warning">未支付</Tag>}</Descriptions.Item><Descriptions.Item label="项目负责人">{selected.owner || "未分配"}</Descriptions.Item></Descriptions><Typography.Text type="secondary">此处仅展示当前环节状态；保存动作由接入的客户交付 API 完成。</Typography.Text></Space> : null}
    </Drawer>
  </Card>;
}
