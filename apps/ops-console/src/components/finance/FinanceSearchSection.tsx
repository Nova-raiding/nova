import { DownloadOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Form, Input, Row, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useRef, useState } from "react";
import { financeRecordKinds, type FinanceRecordKind, type FinanceSearchQuery, type FinanceSearchRecord } from "../../../../../packages/contracts/src/ops/finance-search.js";
import type { FinanceSearchController } from "../../hooks/useFinanceSearch.js";
import { FinanceDetailDrawer, financeRecordCostEvidence } from "./FinanceDetailDrawer.js";
import { EnterpriseIdentity } from "../EnterpriseIdentity.js";

interface FinanceSearchSectionProps {
  controller: FinanceSearchController
  canExport?: boolean
  showProviderStatementStatus?: boolean
  compactSummary?: boolean
}
type Filters = { text?: string; workspaceIds?: string; kinds?: FinanceRecordKind[]; statuses?: string[] };

export function parseFinanceWorkspaceIdFilter(value?: string): string[] | undefined {
  return value?.split(/[\s,，]+/).map(workspaceId => workspaceId.trim()).filter(Boolean);
}

const kindLabel: Record<FinanceRecordKind, string> = {
  recharge_order: "充值订单", wallet_transaction: "钱包流水", subscription_order: "订阅订单", usage_entry: "任务额度", model_usage: "模型用量",
};
const statusLabel: Record<string, string> = {
  refunded: "已退款", settled: "已结算", pending_cost: "待成本核验", consumed: "已消耗", paid: "已支付", pending: "待处理", failed: "失败", manual_attention: "待人工处理",
};
const readableStatus = (value: string) => statusLabel[value.toLowerCase()] ?? value;
const money = (value: number | undefined, precision = 2) => value === undefined ? "—" : `¥${value.toFixed(precision)}`;

export function FinanceSearchSection({ controller, canExport = false, showProviderStatementStatus = true, compactSummary = false }: FinanceSearchSectionProps) {
  const [form] = Form.useForm<Filters>();
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const submittedQueryRef = useRef<Partial<FinanceSearchQuery> | undefined>(undefined);
  const initialErrorRef = useRef<HTMLDivElement>(null);
  const detailTriggerRef = useRef<HTMLElement>(null);
  const summary = controller.page?.summary;
  const initialLoadFailed = Boolean(controller.error && !controller.page && controller.records.length === 0);
  const hasStaleSnapshot = controller.resultsStale && Boolean(controller.page);
  const summaryNumber = (value: number | undefined) => summary ? (value ?? 0) : "—";
  const summaryMoney = (value: number | undefined) => summary ? (value ?? 0) : "—";
  const summaryColSpan = compactSummary ? 6 : 4;
  useEffect(() => {
    if (initialLoadFailed) initialErrorRef.current?.focus({ preventScroll: true });
  }, [initialLoadFailed]);
  useEffect(() => {
    // Reflect the server-confirmed query in the controls only after a successful
    // search. A failed attempt must leave its submitted values available to retry.
    form.setFieldsValue({
      text: controller.query.text,
      workspaceIds: controller.query.workspaceIds?.join(", "),
      kinds: controller.query.kinds,
      statuses: controller.query.statuses,
    });
    submittedQueryRef.current = {
      text: controller.query.text,
      workspaceIds: controller.query.workspaceIds,
      kinds: controller.query.kinds,
      statuses: controller.query.statuses,
    };
  }, [controller.query, form]);
  const columns: ColumnsType<FinanceSearchRecord> = [
    { title: "类型", dataIndex: "kind", width: 120, fixed: "left", render: (kind: FinanceRecordKind) => <Tag>{kindLabel[kind]}</Tag> },
    { title: "企业主体", key: "enterprise", width: 220, render: (_value, record) => <EnterpriseIdentity name={record.enterpriseName} workspaceId={record.workspaceId} /> },
    { title: "记录", key: "record", width: 240, render: (_value, record) => <Space orientation="vertical" size={0}><Typography.Text ellipsis={{ tooltip: record.id }} code>{record.id}</Typography.Text>{record.reference ? <Typography.Text type="secondary" ellipsis={{ tooltip: record.reference }}>引用：{record.reference}</Typography.Text> : null}</Space> },
    { title: "状态", dataIndex: "status", width: 130, render: value => <Tag color={value === "failed" || value === "manual_attention" ? "red" : "blue"}>{readableStatus(value)}</Tag> },
    { title: "金额", dataIndex: "amountCny", width: 110, align: "right", render: value => money(value) },
    { title: "成本 / 客户计费", key: "cost", width: 190, align: "right", render: (_value, record) => <Space orientation="vertical" size={0}><Typography.Text type="secondary">成本 {financeRecordCostEvidence(record.kind, record.providerCostCny)}</Typography.Text><Typography.Text>计费 {financeRecordCostEvidence(record.kind, record.customerChargeCny)}</Typography.Text></Space> },
    { title: "发生时间", dataIndex: "occurredAt", width: 180, render: value => new Date(value).toLocaleString() },
    { title: "操作", key: "action", width: 100, fixed: "right", render: (_, record) => <Button type="link" ref={button => { if (controller.selected?.id === record.id) detailTriggerRef.current = button; }} onClick={event => { detailTriggerRef.current = event.currentTarget; void controller.openDetail(record); }} aria-label={`查看 ${record.label} ${record.id} 详情`}>详情</Button> },
  ];

  const submit = async (values: Filters) => {
    const submittedQuery = {
      text: values.text?.trim() || undefined,
      workspaceIds: parseFinanceWorkspaceIdFilter(values.workspaceIds),
      kinds: values.kinds,
      statuses: values.statuses?.map(value => value.trim()).filter(Boolean),
    };
    submittedQueryRef.current = submittedQuery;
    await controller.search(submittedQuery);
  };
  const retrySearch = () => void controller.search(submittedQueryRef.current ?? {});
  const refreshSearch = () => {
    submittedQueryRef.current = {
      text: controller.query.text,
      workspaceIds: controller.query.workspaceIds,
      kinds: controller.query.kinds,
      statuses: controller.query.statuses,
    };
    void controller.search(submittedQueryRef.current);
  };

  return (
    <Card
      id="ops-finance-search"
      className="ops-section-anchor"
      title="跨企业主体财务检索"
      extra={<Space wrap>
        <Button icon={<ReloadOutlined />} loading={controller.loading} onClick={refreshSearch} aria-label="刷新财务检索结果">刷新</Button>
        {canExport ? <Button icon={<DownloadOutlined />} loading={controller.exporting} disabled={!controller.records.length || controller.loading || controller.resultsStale} onClick={() => void controller.downloadCsv()}>导出当前筛选</Button> : null}
      </Space>}
    >
      <Form form={form} layout="vertical" onFinish={values => void submit(values)} aria-label="财务检索筛选">
        <Row gutter={[16, 0]} align="bottom">
          <Col xs={24} md={9}><Form.Item name="text" label="关键词"><Input allowClear maxLength={200} placeholder="记录号、订单号、模型或状态" /></Form.Item></Col>
          <Col xs={24} md={9}><Form.Item name="workspaceIds" label="Workspace ID"><Input allowClear placeholder="输入一个或多个 Workspace ID，使用空格或逗号分隔" /></Form.Item></Col>
          <Col xs={24} md={6}><Form.Item label=" "><Space.Compact block><Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={controller.loading} block>检索</Button><Button type="default" aria-expanded={showAdvancedFilters} aria-controls="finance-advanced-filters" onClick={() => setShowAdvancedFilters(visible => !visible)}>{showAdvancedFilters ? "收起筛选" : "高级筛选"}</Button></Space.Compact></Form.Item></Col>
        </Row>
        {showAdvancedFilters ? <Row id="finance-advanced-filters" gutter={[16, 0]} align="bottom">
          <Col xs={24} md={8}><Form.Item name="kinds" label="记录类型"><Select mode="multiple" allowClear options={financeRecordKinds.map(value => ({ value, label: kindLabel[value] }))} /></Form.Item></Col>
          <Col xs={24} md={16}><Form.Item name="statuses" label="状态"><Select mode="tags" tokenSeparators={[",", "，"]} maxTagCount="responsive" placeholder="输入状态后回车，可多选" /></Form.Item></Col>
        </Row> : null}
      </Form>

      {hasStaleSnapshot ? <Alert
        style={{ marginBottom: 16 }}
        type={controller.error ? "error" : "warning"}
        showIcon
        title={controller.error ? "本次检索失败，以下仍是上次成功快照" : "本次检索尚未完成，以下暂为上次成功快照"}
        description={`旧检索条件：${describeFinanceQuery(controller.query)}；快照时间：${controller.page?.snapshotAt ?? "未知"}。当前结果不代表本次表单筛选，检索成功前禁止导出。`}
      /> : null}

      {controller.error && <div ref={initialErrorRef} tabIndex={initialLoadFailed ? -1 : undefined} aria-label={initialLoadFailed ? "财务检索错误摘要" : undefined}>
        <Alert type="error" showIcon title="财务检索失败" description={controller.error} action={<Button size="small" aria-label="重试财务检索" onClick={retrySearch}>重试</Button>} role="alert" aria-live="assertive" aria-atomic="true" />
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
      {summary ? <Typography.Text type="secondary" aria-live="polite" style={{ display: "block", marginBottom: 8 }}>
        已展示 {controller.records.length} 条，共 {summary.totalRecords} 条匹配记录。{controller.page?.nextCursor ? "还有未加载记录。" : "已加载全部匹配记录。"}
      </Typography.Text> : null}
      <Table<FinanceSearchRecord>
        rowKey={record => `${record.kind}:${record.workspaceId}:${record.id}`}
        size="small"
        loading={controller.loading}
        columns={columns}
        dataSource={controller.records}
        pagination={false}
        scroll={{ x: 1450 }}
        locale={{ emptyText: controller.loading ? "正在加载" : "当前筛选条件下没有财务记录" }}
      />
      {controller.page?.nextCursor ? (
        <Button
          block
          style={{ marginTop: 12 }}
          type="default"
          loading={controller.loadingMore}
          disabled={controller.loading}
          onClick={() => void controller.loadMore()}
        >
          加载更多财务记录
        </Button>
      ) : null}
      </> : (
        <div role="status" aria-live="polite" style={{ marginTop: 16 }}>
          <Typography.Text type="secondary">财务数据尚未取得，当前状态不能解释为零记录或零金额。</Typography.Text>
        </div>
      )}
      <FinanceDetailDrawer selected={controller.selected} detail={controller.detail} loading={controller.detailLoading} error={controller.detailError} onRetry={() => void controller.retryDetail()} onClose={() => { controller.closeDetail(); window.requestAnimationFrame(() => detailTriggerRef.current?.focus({ preventScroll: true })); }} />
    </Card>
  );
}

function describeFinanceQuery(query: FinanceSearchController["query"]): string {
  const parts = [
    query.text ? `关键词 ${query.text}` : undefined,
    query.workspaceIds?.length ? `Workspace ${query.workspaceIds.join(", ")}` : undefined,
    query.kinds?.length ? `类型 ${query.kinds.join(", ")}` : undefined,
    query.statuses?.length ? `状态 ${query.statuses.join(", ")}` : undefined,
    query.fromAt ? `开始时间 ${query.fromAt}` : undefined,
    query.toAt ? `结束时间 ${query.toAt}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join("；") : "默认筛选条件";
}
