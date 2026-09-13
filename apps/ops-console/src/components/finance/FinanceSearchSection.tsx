import { DownloadOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Form, Input, Row, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useRef, useState } from "react";
import { financeRecordKinds, type FinanceRecordKind, type FinanceSearchRecord } from "../../../../../packages/contracts/src/ops/finance-search.js";
import type { FinanceSearchController } from "../../hooks/useFinanceSearch.js";
import { FinanceDetailDrawer } from "./FinanceDetailDrawer.js";
import { EnterpriseIdentity } from "../EnterpriseIdentity.js";

interface FinanceSearchSectionProps {
  controller: FinanceSearchController
  showProviderStatementStatus?: boolean
  compactSummary?: boolean
}
type Filters = { text?: string; workspaceIds?: string; kinds?: FinanceRecordKind[]; statuses?: string[] };

const kindLabel: Record<FinanceRecordKind, string> = {
  recharge_order: "充值订单", wallet_transaction: "钱包流水", subscription_order: "订阅订单", usage_entry: "任务额度", model_usage: "模型用量",
};
const statusLabel: Record<string, string> = {
  refunded: "已退款", settled: "已结算", pending_cost: "待成本核验", consumed: "已消耗", paid: "已支付", pending: "待处理", failed: "失败", manual_attention: "待人工处理",
};
const readableStatus = (value: string) => statusLabel[value.toLowerCase()] ?? value;
const money = (value: number | undefined, precision = 2) => value === undefined ? "—" : `¥${value.toFixed(precision)}`;
const moneyEvidence = (value: number | undefined, precision = 2) => value === undefined ? "待核验" : `¥${value.toFixed(precision)}`;

export function FinanceSearchSection({ controller, showProviderStatementStatus = true, compactSummary = false }: FinanceSearchSectionProps) {
  const [form] = Form.useForm<Filters>();
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const initialErrorRef = useRef<HTMLDivElement>(null);
  const detailTriggerRef = useRef<HTMLElement>(null);
  const summary = controller.page?.summary;
  const initialLoadFailed = Boolean(controller.error && !controller.page && controller.records.length === 0);
  const summaryNumber = (value: number | undefined) => summary ? (value ?? 0) : "—";
  const summaryMoney = (value: number | undefined) => summary ? (value ?? 0) : "—";
  const summaryColSpan = compactSummary ? 6 : 4;
  useEffect(() => {
    if (initialLoadFailed) initialErrorRef.current?.focus({ preventScroll: true });
  }, [initialLoadFailed]);
  const columns: ColumnsType<FinanceSearchRecord> = [
    { title: "类型", dataIndex: "kind", width: 120, fixed: "left", render: (kind: FinanceRecordKind) => <Tag>{kindLabel[kind]}</Tag> },
    { title: "企业主体", key: "enterprise", width: 220, render: (_value, record) => <EnterpriseIdentity name={record.enterpriseName} workspaceId={record.workspaceId} /> },
    { title: "记录", key: "record", width: 240, render: (_value, record) => <Space orientation="vertical" size={0}><Typography.Text ellipsis={{ tooltip: record.id }} code>{record.id}</Typography.Text>{record.reference ? <Typography.Text type="secondary" ellipsis={{ tooltip: record.reference }}>引用：{record.reference}</Typography.Text> : null}</Space> },
    { title: "状态", dataIndex: "status", width: 130, render: value => <Tag color={value === "failed" || value === "manual_attention" ? "red" : "blue"}>{readableStatus(value)}</Tag> },
    { title: "金额", dataIndex: "amountCny", width: 110, align: "right", render: value => moneyEvidence(value) },
    { title: "成本 / 客户计费", key: "cost", width: 190, align: "right", render: (_value, record) => <Space orientation="vertical" size={0}><Typography.Text type="secondary">成本 {moneyEvidence(record.providerCostCny, 6)}</Typography.Text><Typography.Text>计费 {moneyEvidence(record.customerChargeCny, 6)}</Typography.Text></Space> },
    { title: "发生时间", dataIndex: "occurredAt", width: 180, render: value => new Date(value).toLocaleString() },
    { title: "操作", key: "action", width: 100, fixed: "right", render: (_, record) => <Button type="link" ref={button => { if (controller.selected?.id === record.id) detailTriggerRef.current = button; }} onClick={event => { detailTriggerRef.current = event.currentTarget; void controller.openDetail(record); }} aria-label={`查看 ${record.label} ${record.id} 详情`}>详情</Button> },
  ];

  const submit = async (values: Filters) => controller.search({
    text: values.text?.trim() || undefined,
    workspaceIds: values.workspaceIds?.split(/[\s,，]+/).map(value => value.trim()).filter(Boolean),
    kinds: values.kinds,
    statuses: values.statuses?.map(value => value.trim()).filter(Boolean),
  });

  return (
    <Card
      id="ops-finance-search"
      className="ops-section-anchor"
      title="跨企业主体财务检索"
      extra={<Space wrap>
        <Button icon={<ReloadOutlined />} loading={controller.loading} onClick={() => void controller.search()} aria-label="刷新财务检索结果">刷新</Button>
        <Button icon={<DownloadOutlined />} loading={controller.exporting} disabled={!controller.records.length} onClick={() => void controller.downloadCsv()}>导出当前筛选</Button>
      </Space>}
    >
      <Form form={form} layout="vertical" onFinish={values => void submit(values)} aria-label="财务检索筛选">
        <Row gutter={[16, 0]} align="bottom">
          <Col xs={24} md={9}><Form.Item name="text" label="关键词"><Input allowClear maxLength={200} placeholder="记录号、订单号、模型或状态" /></Form.Item></Col>
          <Col xs={24} md={9}><Form.Item name="workspaceIds" label="企业主体"><Input allowClear placeholder="企业名称或 Workspace ID" /></Form.Item></Col>
          <Col xs={24} md={6}><Form.Item label=" "><Space.Compact block><Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={controller.loading} block>检索</Button><Button type="default" aria-expanded={showAdvancedFilters} aria-controls="finance-advanced-filters" onClick={() => setShowAdvancedFilters(visible => !visible)}>{showAdvancedFilters ? "收起筛选" : "高级筛选"}</Button></Space.Compact></Form.Item></Col>
        </Row>
        {showAdvancedFilters ? <Row id="finance-advanced-filters" gutter={[16, 0]} align="bottom">
          <Col xs={24} md={8}><Form.Item name="kinds" label="记录类型"><Select mode="multiple" allowClear options={financeRecordKinds.map(value => ({ value, label: kindLabel[value] }))} /></Form.Item></Col>
          <Col xs={24} md={16}><Form.Item name="statuses" label="状态"><Select mode="tags" tokenSeparators={[",", "，"]} maxTagCount="responsive" placeholder="输入状态后回车，可多选" /></Form.Item></Col>
        </Row> : null}
      </Form>

      {controller.error && <div ref={initialErrorRef} tabIndex={initialLoadFailed ? -1 : undefined} aria-label={initialLoadFailed ? "财务检索错误摘要" : undefined}>
        <Alert type="error" showIcon title="财务检索失败" description={controller.error} action={<Button size="small" aria-label="重试财务检索" onClick={() => void controller.search()}>重试</Button>} role="alert" aria-live="assertive" aria-atomic="true" />
      </div>}
      {controller.exportError && <Alert type="error" showIcon title="财务导出失败" description={controller.exportError} role="alert" />}

      {!initialLoadFailed ? <><Row gutter={[12, 12]} aria-label="财务检索汇总">
        <Col xs={12} lg={summaryColSpan}><Statistic title="记录数" value={summaryNumber(summary?.totalRecords)} /></Col>
        <Col xs={12} lg={summaryColSpan}><Statistic title="真实充值到账" value={summary?.verifiedRechargeOrderCny ?? "—"} precision={summary?.verifiedRechargeOrderCny === undefined ? undefined : 2} prefix={summary?.verifiedRechargeOrderCny === undefined ? undefined : "¥"} /></Col>
        {!compactSummary && <Col xs={12} lg={summaryColSpan}><Statistic title="月度订阅收入" value={summary?.subscriptionOrderCny ?? "—"} precision={summary?.subscriptionOrderCny === undefined ? undefined : 2} prefix={summary?.subscriptionOrderCny === undefined ? undefined : "¥"} /></Col>}
        {!compactSummary && <Col xs={12} lg={summaryColSpan}><Statistic title="创意点包收入" value={summary?.pointPackOrderCny ?? "—"} precision={summary?.pointPackOrderCny === undefined ? undefined : 2} prefix={summary?.pointPackOrderCny === undefined ? undefined : "¥"} /></Col>}
        {!compactSummary && <Col xs={12} lg={summaryColSpan}><Statistic title="钱包净额" value={summaryMoney(summary?.walletNetCny)} precision={summary ? 2 : undefined} prefix={summary ? "¥" : undefined} /></Col>}
        <Col xs={12} lg={summaryColSpan}><Statistic title="本地成本快照" value={summary?.providerCostCny ?? "—"} precision={6} prefix={summary?.providerCostCny == null ? undefined : "¥"} /></Col>
        <Col xs={12} lg={summaryColSpan}><Statistic title="客户计费" value={summaryMoney(summary?.customerChargeCny)} precision={summary ? 6 : undefined} prefix={summary ? "¥" : undefined} /></Col>
      </Row>
      {summary?.providerCostStatus && summary.providerCostStatus !== "verified" ? <Alert style={{ marginTop: 16 }} type="warning" showIcon title="Provider 成本证据不完整" description={summary.providerCostStatus === "unavailable" ? "部分企业主体财务数据读取失败，成本汇总不可用。" : `有 ${summary.missingCostEvidenceCount ?? 0} 条模型用量缺少成本证据，当前不显示为 ¥0。`} /> : null}
      {showProviderStatementStatus && summary?.providerStatementStatus && summary.providerStatementStatus !== "balanced" ? <Alert style={{ marginTop: 16 }} type="warning" showIcon title={summary.providerStatementStatus === "not_checked" ? "本次检索未执行 Provider 对账" : "Provider 尚未完成对账"} description={summary.providerStatementStatus === "not_checked" ? "当前结果只证明本地成本快照；它不代表全局已与 Provider 平账。请打开模型用量对账页执行或查看外部账单核对。" : summary.providerStatementStatus === "unavailable" ? "Provider 对账状态不可用，不能将本地成本解释为已验证。" : "Provider 对账仍需人工处理，当前不显示为已平账。"} /> : null}

      <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>{controller.loading ? "正在加载财务记录" : `已加载 ${controller.records.length} 条财务记录`}</div>
      <Table<FinanceSearchRecord>
        rowKey={record => `${record.kind}:${record.workspaceId}:${record.id}`}
        size="small"
        loading={controller.loading}
        columns={columns}
        dataSource={controller.records}
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
        scroll={{ x: 1450 }}
        locale={{ emptyText: controller.loading ? "正在加载" : "当前筛选条件下没有财务记录" }}
      />
      </> : (
        <div role="status" aria-live="polite" style={{ marginTop: 16 }}>
          <Typography.Text type="secondary">财务数据尚未取得，当前状态不能解释为零记录或零金额。</Typography.Text>
        </div>
      )}
      <FinanceDetailDrawer selected={controller.selected} detail={controller.detail} loading={controller.detailLoading} error={controller.detailError} onRetry={() => void controller.retryDetail()} onClose={() => { controller.closeDetail(); window.requestAnimationFrame(() => detailTriggerRef.current?.focus({ preventScroll: true })); }} />
    </Card>
  );
}
