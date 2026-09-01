import { DownloadOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Form, Input, Row, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useRef } from "react";
import { financeRecordKinds, type FinanceRecordKind, type FinanceSearchRecord } from "../../../../../packages/contracts/src/ops/finance-search.js";
import type { FinanceSearchController } from "../../hooks/useFinanceSearch.js";
import { FinanceDetailDrawer } from "./FinanceDetailDrawer.js";

interface FinanceSearchSectionProps { controller: FinanceSearchController }
type Filters = { text?: string; workspaceIds?: string; kinds?: FinanceRecordKind[]; statuses?: string[] };

const kindLabel: Record<FinanceRecordKind, string> = {
  recharge_order: "充值订单", wallet_transaction: "钱包流水", subscription_order: "订阅订单", usage_entry: "任务额度", model_usage: "模型用量",
};
const money = (value: number | undefined, precision = 2) => value === undefined ? "—" : `¥${value.toFixed(precision)}`;

export function FinanceSearchSection({ controller }: FinanceSearchSectionProps) {
  const [form] = Form.useForm<Filters>();
  const initialErrorRef = useRef<HTMLDivElement>(null);
  const detailTriggerRef = useRef<HTMLElement>(null);
  const summary = controller.page?.summary;
  const initialLoadFailed = Boolean(controller.error && !controller.page && controller.records.length === 0);
  useEffect(() => {
    if (initialLoadFailed) initialErrorRef.current?.focus({ preventScroll: true });
  }, [initialLoadFailed]);
  const columns: ColumnsType<FinanceSearchRecord> = [
    { title: "类型", dataIndex: "kind", width: 120, fixed: "left", render: (kind: FinanceRecordKind) => <Tag>{kindLabel[kind]}</Tag> },
    { title: "工作区", dataIndex: "workspaceId", width: 170, render: value => <Typography.Text copyable>{value}</Typography.Text> },
    { title: "记录号", dataIndex: "id", width: 210, render: value => <Typography.Text ellipsis={{ tooltip: value }}>{value}</Typography.Text> },
    { title: "状态", dataIndex: "status", width: 130, render: value => <Tag color={value === "failed" || value === "manual_attention" ? "red" : "blue"}>{value}</Tag> },
    { title: "业务引用", dataIndex: "reference", width: 180, render: value => value ?? "—" },
    { title: "金额", dataIndex: "amountCny", width: 110, align: "right", render: value => money(value) },
    { title: "Provider 成本", dataIndex: "providerCostCny", width: 140, align: "right", render: value => money(value, 6) },
    { title: "客户计费", dataIndex: "customerChargeCny", width: 130, align: "right", render: value => money(value, 6) },
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
      title="跨工作区财务检索"
      extra={<Space wrap>
        <Button icon={<ReloadOutlined />} loading={controller.loading} onClick={() => void controller.search()} aria-label="刷新财务检索结果">刷新</Button>
        <Button icon={<DownloadOutlined />} loading={controller.exporting} disabled={!controller.records.length} onClick={() => void controller.downloadCsv()}>导出当前筛选</Button>
      </Space>}
    >
      <Form form={form} layout="vertical" onFinish={values => void submit(values)} aria-label="财务检索筛选">
        <Row gutter={[16, 0]} align="bottom">
          <Col xs={24} md={8}><Form.Item name="text" label="关键词"><Input allowClear maxLength={200} placeholder="记录号、订单号、模型或状态" /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="workspaceIds" label="工作区"><Input allowClear placeholder="多个工作区用逗号分隔" /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="kinds" label="记录类型"><Select mode="multiple" allowClear options={financeRecordKinds.map(value => ({ value, label: kindLabel[value] }))} /></Form.Item></Col>
          <Col xs={24} md={16}><Form.Item name="statuses" label="状态"><Select mode="tags" tokenSeparators={[",", "，"]} maxTagCount="responsive" placeholder="输入状态后回车，可多选" /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item label=" "><Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={controller.loading} block>检索</Button></Form.Item></Col>
        </Row>
      </Form>

      {controller.error && <div ref={initialErrorRef} tabIndex={initialLoadFailed ? -1 : undefined} aria-label={initialLoadFailed ? "财务检索错误摘要" : undefined}>
        <Alert type="error" showIcon title="财务检索失败" description={controller.error} action={<Button size="small" aria-label="重试财务检索" onClick={() => void controller.search()}>重试</Button>} role="alert" aria-live="assertive" aria-atomic="true" />
      </div>}
      {controller.exportError && <Alert type="error" showIcon title="财务导出失败" description={controller.exportError} role="alert" />}

      {!initialLoadFailed ? <><Row gutter={[12, 12]} aria-label="财务检索汇总">
        <Col xs={12} lg={4}><Statistic title="记录数" value={summary?.totalRecords ?? 0} /></Col>
        <Col xs={12} lg={4}><Statistic title="充值订单" value={summary?.rechargeOrderCny ?? 0} precision={2} prefix="¥" /></Col>
        <Col xs={12} lg={4}><Statistic title="订阅订单" value={summary?.subscriptionOrderCny ?? 0} precision={2} prefix="¥" /></Col>
        <Col xs={12} lg={4}><Statistic title="钱包净额" value={summary?.walletNetCny ?? 0} precision={2} prefix="¥" /></Col>
        <Col xs={12} lg={4}><Statistic title="Provider 成本" value={summary?.providerCostCny ?? 0} precision={6} prefix="¥" /></Col>
        <Col xs={12} lg={4}><Statistic title="客户计费" value={summary?.customerChargeCny ?? 0} precision={6} prefix="¥" /></Col>
      </Row>

      <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>{controller.loading ? "正在加载财务记录" : `已加载 ${controller.records.length} 条财务记录`}</div>
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
      {controller.page?.nextCursor && <div style={{ display: "flex", justifyContent: "center", paddingTop: 16 }}><Button loading={controller.loadingMore} onClick={() => void controller.loadMore()}>加载更多</Button></div>}</> : (
        <div role="status" aria-live="polite" style={{ marginTop: 16 }}>
          <Typography.Text type="secondary">财务数据尚未取得，当前状态不能解释为零记录或零金额。</Typography.Text>
        </div>
      )}
      <FinanceDetailDrawer selected={controller.selected} detail={controller.detail} loading={controller.detailLoading} error={controller.detailError} onRetry={() => void controller.retryDetail()} onClose={() => { controller.closeDetail(); window.requestAnimationFrame(() => detailTriggerRef.current?.focus({ preventScroll: true })); }} />
    </Card>
  );
}
