import { Alert, Button, Descriptions, Drawer, Empty, Skeleton, Tag, Typography } from "antd";
import { useEffect, useRef } from "react";
import type { FinanceRecordDetail, FinanceRecordKind, FinanceSearchRecord } from "../../../../../packages/contracts/src/ops/finance-search.js";
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
export const financeRecordCostEvidence = (kind: FinanceRecordKind, value: number | undefined) =>
  kind === "model_usage" ? evidence(value, 6) : "不适用";
const attributeLabels: Record<string, string> = {
  channel: "支付渠道", payment_mode: "支付模式", created_by_actor_id: "登记操作人",
  transaction_type: "交易类型", actor_id: "操作人", order_id: "关联订单",
  plan_code: "套餐代码", billing_cycle: "计费周期", payment_provider: "支付方式",
  sku_code: "套餐代码", sku_version_id: "套餐版本",
  task_id: "关联任务", units: "用量单位", refunded: "是否已退款",
  action_id: "模型调用", modality: "模型模态", model: "模型",
  total_tokens: "Token 总量", settlement_status: "结算状态", budget_run_key: "预算执行标识",
};
const attributeValues: Record<string, Record<string, string>> = {
  payment_provider: { owner_attested_cash: "现金收款（负责人核验）", alipay: "支付宝" },
  channel: { alipay: "支付宝" },
  billing_cycle: { monthly: "月度", yearly: "年度" },
  payment_mode: { fixture: "演示记录" },
};
export const financeDetailAttributeLabel = (key: string) => attributeLabels[key] ?? key;
export const financeDetailAttributeValue = (key: string, value: string | number | boolean | null) => {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  const raw = String(value);
  const friendly = attributeValues[key]?.[raw];
  return friendly && friendly !== raw ? `${friendly} · ${raw}` : raw;
};

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
          <Descriptions.Item label="金额">{detail.amountCny === undefined ? "—" : `¥${detail.amountCny.toFixed(2)}`}</Descriptions.Item>
          <Descriptions.Item label="Provider 成本">{financeRecordCostEvidence(detail.kind, detail.providerCostCny)}</Descriptions.Item>
          <Descriptions.Item label="客户计费">{financeRecordCostEvidence(detail.kind, detail.customerChargeCny)}</Descriptions.Item>
          <Descriptions.Item label="用量">{detail.units ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="发生时间">{time(detail.occurredAt)}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{time(detail.updatedAt)}</Descriptions.Item>
          <Descriptions.Item label="版本"><Typography.Text code>{detail.version}</Typography.Text></Descriptions.Item>
          {Object.entries(detail.attributes).map(([key, value]) => <Descriptions.Item key={key} label={financeDetailAttributeLabel(key)}>{financeDetailAttributeValue(key, value)}</Descriptions.Item>)}
        </Descriptions>
      )}
    </Drawer>
  );
}
