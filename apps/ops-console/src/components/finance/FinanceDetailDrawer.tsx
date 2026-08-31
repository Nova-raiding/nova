import { Alert, Button, Descriptions, Drawer, Empty, Skeleton, Tag, Typography } from "antd";
import type { FinanceRecordDetail, FinanceSearchRecord } from "../../../../../packages/contracts/src/ops/finance-search.js";

interface FinanceDetailDrawerProps {
  selected?: FinanceSearchRecord;
  detail?: FinanceRecordDetail;
  loading: boolean;
  error?: string;
  onRetry(): void;
  onClose(): void;
}

const time = (value: string) => new Date(value).toLocaleString();

export function FinanceDetailDrawer({ selected, detail, loading, error, onRetry, onClose }: FinanceDetailDrawerProps) {
  return (
    <Drawer
      open={Boolean(selected)}
      title={selected ? `财务详情 · ${selected.label}` : "财务详情"}
      size="large"
      onClose={onClose}
      destroyOnHidden
      aria-label="财务记录详情"
    >
      {loading && <Skeleton active paragraph={{ rows: 8 }} aria-label="正在加载财务详情" />}
      {!loading && error && <Alert type="error" showIcon title="详情加载失败" description={error} action={<Button onClick={onRetry}>重试详情</Button>} role="alert" />}
      {!loading && !error && !detail && <Empty description="没有可显示的财务详情" />}
      {!loading && detail && (
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label="记录类型"><Tag>{detail.label}</Tag></Descriptions.Item>
          <Descriptions.Item label="状态"><Tag>{detail.status}</Tag></Descriptions.Item>
          <Descriptions.Item label="工作区"><Typography.Text copyable>{detail.workspaceId}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="记录号"><Typography.Text copyable>{detail.id}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="业务引用">{detail.reference ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="金额">{detail.amountCny === undefined ? "—" : `¥${detail.amountCny.toFixed(2)}`}</Descriptions.Item>
          <Descriptions.Item label="Provider 成本">{detail.providerCostCny === undefined ? "—" : `¥${detail.providerCostCny.toFixed(6)}`}</Descriptions.Item>
          <Descriptions.Item label="客户计费">{detail.customerChargeCny === undefined ? "—" : `¥${detail.customerChargeCny.toFixed(6)}`}</Descriptions.Item>
          <Descriptions.Item label="用量">{detail.units ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="发生时间">{time(detail.occurredAt)}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{time(detail.updatedAt)}</Descriptions.Item>
          <Descriptions.Item label="版本"><Typography.Text code>{detail.version}</Typography.Text></Descriptions.Item>
          {Object.entries(detail.attributes).map(([key, value]) => <Descriptions.Item key={key} label={key}>{value === null ? "—" : String(value)}</Descriptions.Item>)}
        </Descriptions>
      )}
    </Drawer>
  );
}
