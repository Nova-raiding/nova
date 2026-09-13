import { Alert, Button, Descriptions, Drawer, Empty, Skeleton, Tag, Typography } from "antd";
import { useEffect, useRef } from "react";
import type { FinanceRecordDetail, FinanceSearchRecord } from "../../../../../packages/contracts/src/ops/finance-search.js";
import { EnterpriseIdentity } from "../EnterpriseIdentity.js";

interface FinanceDetailDrawerProps {
  selected?: FinanceSearchRecord;
  detail?: FinanceRecordDetail;
  loading: boolean;
  error?: string;
  onRetry(): void;
  onClose(): void;
}

const time = (value: string) => new Date(value).toLocaleString();
const statusLabel: Record<string, string> = { refunded: "已退款", settled: "已结算", pending_cost: "待成本核验", consumed: "已消耗", paid: "已支付", pending: "待处理", failed: "失败", manual_attention: "待人工处理" };
const readableStatus = (value: string) => statusLabel[value.toLowerCase()] ?? value;
const evidence = (value: number | undefined, precision: number) => value === undefined ? "待核验" : `¥${value.toFixed(precision)}`;

export function FinanceDetailDrawer({ selected, detail, loading, error, onRetry, onClose }: FinanceDetailDrawerProps) {
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  return (
    <Drawer
      open={Boolean(selected)}
      title={selected ? `财务详情 · ${selected.label}` : "财务详情"}
      size="large"
      onClose={onClose}
      destroyOnHidden
      aria-label="财务记录详情"
      aria-busy={loading || undefined}
    >
      {loading && <div role="status" aria-live="polite" aria-label="正在加载财务详情"><Skeleton active paragraph={{ rows: 8 }} /></div>}
      {!loading && error && <div ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-atomic="true" aria-label="财务详情错误摘要">
        <Alert type="error" showIcon title="详情加载失败" description={error} action={<Button htmlType="button" onClick={onRetry} aria-label="重试财务详情" style={{ minHeight: 44 }}>重试详情</Button>} />
      </div>}
      {!loading && !error && !detail && <Empty description="没有可显示的财务详情" />}
      {!loading && detail && (
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label="记录类型"><Tag>{detail.label}</Tag></Descriptions.Item>
          <Descriptions.Item label="状态"><Tag>{readableStatus(detail.status)}</Tag></Descriptions.Item>
          <Descriptions.Item label="企业主体"><EnterpriseIdentity name={detail.enterpriseName} workspaceId={detail.workspaceId} /></Descriptions.Item>
          <Descriptions.Item label="记录号"><Typography.Text copyable>{detail.id}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="业务引用">{detail.reference ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="金额">{evidence(detail.amountCny, 2)}</Descriptions.Item>
          <Descriptions.Item label="Provider 成本">{evidence(detail.providerCostCny, 6)}</Descriptions.Item>
          <Descriptions.Item label="客户计费">{evidence(detail.customerChargeCny, 6)}</Descriptions.Item>
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
