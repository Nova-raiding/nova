import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  CommercialAccessBlock,
  CommercialAccessSummary,
  CommercialCatalogItem,
  CommercialEntitlement,
  CommercialOrderItem,
  CreativePointLedgerEntry,
  CreativePointRateItem,
  ServiceFulfillmentItem,
} from "../../api/commercialOperationsClient.js";
import {
  commercialViewCapability,
  commercialViewLabels,
  commercialViews,
  type CommercialDataState,
  type CommercialOperationsController,
  type CommercialView,
} from "../../hooks/useCommercialOperations.js";

const dash = (value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "—" : String(value);
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "—";
const point = (value: number | null | undefined) => value === null || value === undefined ? "未知" : value.toLocaleString();

function StateTag({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const color = normalized.includes("recover") || normalized.includes("allow") || normalized === "paid" || normalized.includes("approved") || normalized === "active"
    ? "success"
    : normalized.includes("unknown") || normalized.includes("unavailable") || normalized.includes("failed") || normalized.includes("exhaust") || normalized.includes("blocked")
      ? "error"
      : normalized.includes("pending") || normalized.includes("stale") || normalized.includes("insufficient") || normalized.includes("draft")
        ? "warning" : "default";
  return <Tag color={color}>{value}</Tag>;
}

export function CommercialAccessStatusBar({ state, onRetry }: { state: CommercialDataState<CommercialAccessSummary>; onRetry: () => void }) {
  if (state.status === "forbidden") return <Alert type="warning" showIcon title="商业准入摘要不可用" description={<>BLOCKED：当前会话缺少 <Typography.Text code>commercial.access.read</Typography.Text>，页面不会使用旧任务额度或钱包代替。</>} />;
  if (state.status === "loading" || state.status === "idle") return <div className="commercial-access-status" aria-label="正在读取商业准入状态" aria-busy="true"><Skeleton active paragraph={{ rows: 1 }} title={false} /></div>;
  if (state.status === "error") return <Alert role="alert" type="error" showIcon title={`商业准入状态 UNAVAILABLE · ${state.error?.code ?? "COMMERCIAL_OPERATIONS_UNAVAILABLE"}`} description={<Space orientation="vertical" size={2}><span>{state.error?.message}</span>{state.error?.requestId ? <Typography.Text code>request {state.error.requestId}</Typography.Text> : null}</Space>} action={<Button onClick={onRetry}>重试</Button>} />;
  const value = state.data;
  if (!value) return <Alert role="alert" type="error" showIcon title="商业准入状态 UNAVAILABLE" description="服务端没有返回 CommercialAccessDecision；不能将缺失状态视为余额为 0。" />;
  return (
    <section className="commercial-access-status" aria-label="商业准入状态" aria-live="polite">
      <Space size={16} wrap>
        <StateTag value={value.errorCode ?? (value.allowed ? "ALLOWED" : value.balanceState)} />
        <span><Typography.Text type="secondary">可用点数 </Typography.Text><Typography.Text className="ops-token" strong>{point(value.availablePoints)}</Typography.Text></span>
        <span><Typography.Text type="secondary">已预留 </Typography.Text><Typography.Text className="ops-token">{point(value.reservedPoints)}</Typography.Text></span>
        <span><Typography.Text type="secondary">最早到期 </Typography.Text>{time(value.earliestExpiresAt)}</span>
        <span><Typography.Text type="secondary">Access revision </Typography.Text><Typography.Text code>{dash(value.accessRevision)}</Typography.Text></span>
        <span><Typography.Text type="secondary">目录 / 费率 </Typography.Text><Typography.Text code>{dash(value.catalogVersion)} / {dash(value.rateCardVersion)}</Typography.Text></span>
        <span><Typography.Text type="secondary">最后核验 </Typography.Text>{time(value.verifiedAt)}</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重新核验</Button>
      </Space>
    </section>
  );
}

function DataBoundary<T>({ state, capability, onRetry, children }: { state: CommercialDataState<T>; capability: string; onRetry: () => void; children: (data: T) => ReactNode }) {
  if (state.status === "forbidden") return <Alert type="warning" showIcon title="当前视图已阻断" description={<>BLOCKED：服务端未授予 <Typography.Text code>{capability}</Typography.Text>。未授权时不会发起该数据请求。</>} />;
  if ((state.status === "idle" || state.status === "loading") && !state.data) return <div aria-busy="true" aria-label="正在加载商业运营数据"><Skeleton active paragraph={{ rows: 8 }} /></div>;
  return (
    <Space orientation="vertical" size="middle" className="full-width">
      {state.status === "error" ? <Alert role="alert" type="error" showIcon title={`当前视图 UNAVAILABLE · ${state.error?.code ?? "COMMERCIAL_OPERATIONS_UNAVAILABLE"}`} description={<Space orientation="vertical" size={2}><span>{state.error?.message}</span>{state.error?.requestId ? <Typography.Text code>request {state.error.requestId}</Typography.Text> : null}{state.error?.traceId ? <Typography.Text code>trace {state.error.traceId}</Typography.Text> : null}</Space>} action={<Button onClick={onRetry}>重试</Button>} /> : null}
      {state.data ? children(state.data) : state.status === "error" ? null : <Empty description="服务端已返回空结果" />}
    </Space>
  );
}

function TableToolbar({ total, onRefresh }: { total: number; onRefresh: () => void }) {
  return <div className="commercial-filter-bar"><Typography.Text type="secondary">服务端返回 {total} 条</Typography.Text><Button icon={<ReloadOutlined />} onClick={onRefresh}>刷新</Button></div>;
}

function BlockTable({ state, controller }: { state: CommercialOperationsController["data"]["blocks"]; controller: CommercialOperationsController }) {
  const [selected, setSelected] = useState<CommercialAccessBlock>();
  const triggerRef = useRef<HTMLElement | null>(null);
  return <DataBoundary state={state} capability={commercialViewCapability.blocks} onRetry={() => void controller.loadView("blocks")}>{page => <>
    <TableToolbar total={page.total} onRefresh={() => void controller.loadView("blocks")} />
    <Table rowKey="id" size="small" sticky pagination={{ pageSize: 20, showSizeChanger: false }} locale={{ emptyText: "当前没有服务端返回的商业阻断记录" }} dataSource={page.items} scroll={{ x: 1460 }} columns={[
      { title: "状态", dataIndex: "state", fixed: "left", width: 140, sorter: (a, b) => a.state.localeCompare(b.state), render: value => <StateTag value={value} /> },
      { title: "Workspace", dataIndex: "workspaceId", fixed: "left", width: 190, sorter: (a, b) => a.workspaceId.localeCompare(b.workspaceId), render: value => <Typography.Text className="ops-token" copyable>{value}</Typography.Text> },
      { title: "原因 code", dataIndex: "errorCode", width: 230, render: value => <Typography.Text code>{value}</Typography.Text> },
      { title: "可用 / 本次", width: 130, align: "right", render: (_, row) => `${point(row.availablePoints)} / ${point(row.quotedPoints)}` },
      { title: "Revision", dataIndex: "accessRevision", width: 150, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
      { title: "Payment / Grant", width: 190, render: (_, row) => `${dash(row.paymentState)} / ${dash(row.grantState)}` },
      { title: "发生时间", dataIndex: "occurredAt", width: 180, sorter: (a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)), render: time },
      { title: "最后核验", dataIndex: "verifiedAt", width: 180, render: time },
      { title: "操作", fixed: "right", width: 120, render: (_, row) => <Button size="small" onClick={event => { triggerRef.current = event.currentTarget; setSelected(row); }}>查看与恢复</Button> },
    ]} />
    <Drawer title={selected ? `阻断详情 · ${selected.workspaceId}` : "阻断详情"} open={Boolean(selected)} size="large" onClose={() => setSelected(undefined)} afterOpenChange={open => { if (!open) requestAnimationFrame(() => triggerRef.current?.focus()); }} destroyOnHidden>
      {selected ? <Space orientation="vertical" size="large" className="full-width">
        <Alert type={selected.state.toLowerCase().includes("recover") ? "success" : "error"} showIcon title={`${selected.state} · ${selected.errorCode}`} description="支付成功不等于恢复；只有 grant 到账且新 CommercialAccessDecision 通过后才能标记 RECOVERED。" />
        <Descriptions bordered size="small" column={1} items={[
          { key: "workspace", label: "Workspace", children: <Typography.Text code>{selected.workspaceId}</Typography.Text> },
          { key: "points", label: "可用 / quoted", children: `${point(selected.availablePoints)} / ${point(selected.quotedPoints)}` },
          { key: "revision", label: "Access revision", children: <Typography.Text code>{dash(selected.accessRevision)}</Typography.Text> },
          { key: "payment", label: "Payment / Grant", children: `${dash(selected.paymentState)} / ${dash(selected.grantState)}` },
          { key: "request", label: "Request ID", children: <Typography.Text code>{dash(selected.requestId)}</Typography.Text> },
          { key: "actions", label: "服务端 next actions", children: selected.nextActions.length ? selected.nextActions.join("、") : "未返回" },
        ]} />
        {controller.permissions.canRecover ? <Alert type="warning" showIcon title="恢复执行 API 尚未接入" description="当前页面仅展示服务端返回的恢复建议；在具备 reason、expected revision、idempotency 与审计的命令接口前保持 BLOCKED。" /> : <Alert type="info" showIcon title="当前为只读" description="当前会话缺少 commercial.access.recover，不能执行恢复操作。" />}
      </Space> : null}
    </Drawer>
  </>}</DataBoundary>;
}

function EntitlementTable({ state, reload }: { state: CommercialOperationsController["data"]["entitlements"]; reload: () => void }) {
  return <DataBoundary state={state} capability={commercialViewCapability.entitlements} onRetry={reload}>{page => <><TableToolbar total={page.total} onRefresh={reload} /><Table rowKey="id" size="small" sticky pagination={{ pageSize: 20 }} locale={{ emptyText: "服务端未返回 Workspace 权益快照" }} dataSource={page.items} scroll={{ x: 1320 }} columns={[
    { title: "Workspace", dataIndex: "workspaceId", fixed: "left", width: 190, sorter: (a, b) => a.workspaceId.localeCompare(b.workspaceId), render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "SKU", dataIndex: "skuCode", width: 160, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "快照版本", dataIndex: "snapshotVersion", width: 150, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "状态", dataIndex: "status", width: 120, render: value => <StateTag value={value} /> },
    { title: "品牌", dataIndex: "brandLimit", width: 90, align: "right", render: dash }, { title: "店铺", dataIndex: "storeLimit", width: 90, align: "right", render: dash },
    { title: "存储标签", dataIndex: "storageLabel", width: 130, render: dash }, { title: "服务权益", dataIndex: "serviceSummary", width: 220, render: dash },
    { title: "账期", dataIndex: "periodLabel", width: 170, render: dash }, { title: "来源订单", dataIndex: "sourceOrderId", width: 190, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
    { title: "更新时间", dataIndex: "updatedAt", width: 180, sorter: (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)), render: time },
  ]} /></>}</DataBoundary>;
}

function LedgerTable({ state, controller }: { state: CommercialOperationsController["data"]["ledger"]; controller: CommercialOperationsController }) {
  const [selected, setSelected] = useState<CreativePointLedgerEntry>();
  const triggerRef = useRef<HTMLElement | null>(null);
  return <DataBoundary state={state} capability={commercialViewCapability.ledger} onRetry={() => void controller.loadView("ledger")}>{page => <><TableToolbar total={page.total} onRefresh={() => void controller.loadView("ledger")} /><Table rowKey="id" size="small" sticky pagination={{ pageSize: 20 }} locale={{ emptyText: "服务端未返回创意点账本事件" }} dataSource={page.items} scroll={{ x: 1620 }} columns={[
    { title: "时间", dataIndex: "occurredAt", fixed: "left", width: 180, sorter: (a, b) => a.occurredAt.localeCompare(b.occurredAt), render: time },
    { title: "事件", dataIndex: "eventType", width: 130, sorter: (a, b) => a.eventType.localeCompare(b.eventType), render: value => <StateTag value={value} /> },
    { title: "点数增减", dataIndex: "pointsDelta", width: 110, align: "right", sorter: (a, b) => a.pointsDelta - b.pointsDelta },
    { title: "事件后投影", dataIndex: "balanceAfter", width: 120, align: "right", render: point },
    { title: "Workspace", dataIndex: "workspaceId", width: 190, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "来源", dataIndex: "source", width: 150 }, { title: "账期", dataIndex: "periodLabel", width: 150, render: dash },
    { title: "到期", dataIndex: "expiresAt", width: 180, render: time }, { title: "Operation", dataIndex: "operationId", width: 190, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
    { title: "状态", dataIndex: "status", width: 110, render: value => <StateTag value={value} /> },
    { title: "操作", fixed: "right", width: 100, render: (_, row) => <Button size="small" onClick={event => { triggerRef.current = event.currentTarget; setSelected(row); }}>详情</Button> },
  ]} />
  <Drawer title="账本事件详情" open={Boolean(selected)} size="default" onClose={() => setSelected(undefined)} afterOpenChange={open => { if (!open) requestAnimationFrame(() => triggerRef.current?.focus()); }} destroyOnHidden>{selected ? <Descriptions bordered size="small" column={1} items={[
    { key: "id", label: "事件 ID", children: <Typography.Text code>{selected.id}</Typography.Text> }, { key: "workspace", label: "Workspace", children: <Typography.Text code>{selected.workspaceId}</Typography.Text> },
    { key: "operation", label: "Operation", children: <Typography.Text code>{dash(selected.operationId)}</Typography.Text> }, { key: "actor", label: "Actor", children: <Typography.Text code>{dash(selected.actorId)}</Typography.Text> },
    { key: "key", label: "幂等键", children: <Typography.Text code>{dash(selected.idempotencyKey)}</Typography.Text> }, { key: "evidence", label: "证据", children: <Typography.Text code>{Object.keys(selected.evidence).length ? JSON.stringify(selected.evidence) : "未返回"}</Typography.Text> },
  ]} /> : null}</Drawer></>}</DataBoundary>;
}

function CatalogTable({ state, controller }: { state: CommercialOperationsController["data"]["catalog"]; controller: CommercialOperationsController }) {
  const visible = (items: CommercialCatalogItem[]) => controller.permissions.privateSkuReadable ? items : items.filter(item => item.visibility !== "private");
  return <DataBoundary state={state} capability={commercialViewCapability.catalog} onRetry={() => void controller.loadView("catalog")}>{page => <><TableToolbar total={visible(page.items).length} onRefresh={() => void controller.loadView("catalog")} /><Table rowKey="id" size="small" sticky pagination={{ pageSize: 20 }} locale={{ emptyText: "服务端未返回商业目录版本" }} dataSource={visible(page.items)} scroll={{ x: 1440 }} columns={[
    { title: "SKU", dataIndex: "skuCode", fixed: "left", width: 180, sorter: (a, b) => a.skuCode.localeCompare(b.skuCode), render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "名称", dataIndex: "name", width: 180 }, { title: "类型", dataIndex: "type", width: 150 },
    { title: "可见性", dataIndex: "visibility", width: 110, render: value => <StateTag value={value} /> }, { title: "版本", dataIndex: "version", width: 130, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "价格 / 周期", width: 180, render: (_, row) => `${row.priceLabel}${row.cycleLabel ? ` / ${row.cycleLabel}` : ""}` }, { title: "权益摘要", dataIndex: "benefitsSummary", width: 300 },
    { title: "审批 / 生效", dataIndex: "approvalState", width: 150, render: value => <StateTag value={value} /> }, { title: "生效时间", dataIndex: "validFrom", width: 180, render: time },
    { title: "未决项", dataIndex: "unresolved", width: 220, render: value => value.length ? <Typography.Text type="danger">{value.join("、")}</Typography.Text> : "—" },
  ]} />
  {!controller.permissions.canDraftCatalog ? <Alert type="info" showIcon title="目录只读" description="当前会话缺少 commercial.catalog.draft；不会渲染编辑表单。" /> : <Alert type="warning" showIcon title="目录写入 API 尚未接入" description="草稿、校验和发布命令在具备独立 capability、revision 与审计契约前保持 BLOCKED。" />}</>}</DataBoundary>;
}

function OrdersTable({ state, controller }: { state: CommercialOperationsController["data"]["orders"]; controller: CommercialOperationsController }) {
  return <DataBoundary state={state} capability={commercialViewCapability.orders} onRetry={() => void controller.loadView("orders")}>{page => <><TableToolbar total={page.total} onRefresh={() => void controller.loadView("orders")} /><Table rowKey="id" size="small" sticky pagination={{ pageSize: 20 }} locale={{ emptyText: "服务端未返回订单与支付记录" }} dataSource={page.items} scroll={{ x: 1500 }} columns={[
    { title: "订单号", dataIndex: "id", fixed: "left", width: 210, sorter: (a, b) => a.id.localeCompare(b.id), render: value => <Typography.Text code copyable>{value}</Typography.Text> },
    { title: "Workspace", dataIndex: "workspaceId", width: 190, render: value => <Typography.Text code>{value}</Typography.Text> }, { title: "SKU / 版本", width: 210, render: (_, row) => <Typography.Text code>{row.skuCode} / {row.skuVersion}</Typography.Text> },
    { title: "购买点数", dataIndex: "purchasedPoints", width: 110, align: "right", render: point }, { title: "金额", dataIndex: "amountLabel", width: 130, align: "right" },
    { title: "渠道", dataIndex: "channel", width: 110, render: dash }, { title: "Payment", dataIndex: "paymentState", width: 130, render: value => <StateTag value={value} /> },
    { title: "Grant", dataIndex: "grantState", width: 130, render: value => <StateTag value={value} /> }, { title: "Access revision", dataIndex: "accessRevision", width: 150, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
    { title: "创建时间", dataIndex: "createdAt", width: 180, sorter: (a, b) => a.createdAt.localeCompare(b.createdAt), render: time }, { title: "支付时间", dataIndex: "paidAt", width: 180, render: time },
  ]} />
  {controller.permissions.canReconcilePayment ? <Alert type="warning" showIcon title="支付对账写入 API 尚未接入" description="页面不会把 payment success 伪装成 grant 或 RECOVERED；命令接口就绪前保持 BLOCKED。" /> : null}</>}</DataBoundary>;
}

function RatesTable({ state, controller }: { state: CommercialOperationsController["data"]["rates"]; controller: CommercialOperationsController }) {
  return <DataBoundary state={state} capability={commercialViewCapability.rates} onRetry={() => void controller.loadView("rates")}>{page => <><TableToolbar total={page.total} onRefresh={() => void controller.loadView("rates")} /><Table rowKey="id" size="small" sticky pagination={{ pageSize: 20 }} locale={{ emptyText: "服务端未返回创意点费率版本" }} dataSource={page.items} scroll={{ x: 1260 }} columns={[
    { title: "Action", dataIndex: "actionCode", fixed: "left", width: 240, sorter: (a, b) => a.actionCode.localeCompare(b.actionCode), render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "动作", dataIndex: "actionLabel", width: 180 }, { title: "单位", dataIndex: "unitLabel", width: 120 }, { title: "点数规则", dataIndex: "pointsRule", width: 180 },
    { title: "版本", dataIndex: "version", width: 140, render: value => <Typography.Text code>{value}</Typography.Text> }, { title: "审批状态", dataIndex: "approvalState", width: 160, render: value => <StateTag value={value} /> },
    { title: "生效窗口", width: 280, render: (_, row) => `${time(row.validFrom)} — ${time(row.validTo)}` }, { title: "阻断原因", dataIndex: "blockingReason", width: 220, render: dash },
  ]} />
  {controller.permissions.canDraftRate || controller.permissions.canApproveRate ? <Alert type="warning" showIcon title="费率治理命令 API 尚未接入" description="未批准或变量缺失的费率继续显示 RATE_CARD_UNAVAILABLE，不提供生产确认按钮。" /> : <Alert type="info" showIcon title="费率只读" description="当前会话没有费率草稿或审批 capability。" />}</>}</DataBoundary>;
}

function ServicesTable({ state, controller }: { state: CommercialOperationsController["data"]["services"]; controller: CommercialOperationsController }) {
  return <DataBoundary state={state} capability={commercialViewCapability.services} onRetry={() => void controller.loadView("services")}>{page => <><TableToolbar total={page.total} onRefresh={() => void controller.loadView("services")} /><Table rowKey="id" size="small" sticky pagination={{ pageSize: 20 }} locale={{ emptyText: "服务端未返回服务履约记录" }} dataSource={page.items} scroll={{ x: 1320 }} columns={[
    { title: "Workspace", dataIndex: "workspaceId", fixed: "left", width: 190, sorter: (a, b) => a.workspaceId.localeCompare(b.workspaceId), render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "服务类型", dataIndex: "serviceType", width: 160 }, { title: "分配量", dataIndex: "allocationLabel", width: 130 }, { title: "已用量", dataIndex: "usedLabel", width: 130 },
    { title: "排期", dataIndex: "scheduleAt", width: 180, sorter: (a, b) => String(a.scheduleAt).localeCompare(String(b.scheduleAt)), render: time }, { title: "状态", dataIndex: "status", width: 120, render: value => <StateTag value={value} /> },
    { title: "负责人", dataIndex: "ownerLabel", width: 150, render: dash }, { title: "证据", dataIndex: "evidenceLabel", width: 260, render: dash }, { title: "更新时间", dataIndex: "updatedAt", width: 180, render: time },
  ]} />
  {controller.permissions.canWriteService ? <Alert type="warning" showIcon title="履约写入 API 尚未接入" description="在服务端提供独立 capability、reason、revision 和审计契约前保持只读 BLOCKED。" /> : null}</>}</DataBoundary>;
}

function renderView(view: CommercialView, controller: CommercialOperationsController) {
  if (view === "blocks") return <BlockTable state={controller.data.blocks} controller={controller} />;
  if (view === "entitlements") return <EntitlementTable state={controller.data.entitlements} reload={() => void controller.loadView("entitlements")} />;
  if (view === "ledger") return <LedgerTable state={controller.data.ledger} controller={controller} />;
  if (view === "catalog") return <CatalogTable state={controller.data.catalog} controller={controller} />;
  if (view === "orders") return <OrdersTable state={controller.data.orders} controller={controller} />;
  if (view === "rates") return <RatesTable state={controller.data.rates} controller={controller} />;
  return <ServicesTable state={controller.data.services} controller={controller} />;
}

export function CommercialOperationsWorkspace({ controller }: { controller: CommercialOperationsController }) {
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { viewHeadingRef.current?.focus({ preventScroll: true }); }, [controller.view]);
  return (
    <Space orientation="vertical" size="middle" className="full-width commercial-operations-workspace">
      <CommercialAccessStatusBar state={controller.summary} onRetry={() => void controller.loadSummary()} />
      <Tabs activeKey={controller.view} onChange={key => controller.setView(key as CommercialView)} items={commercialViews.map(view => ({ key: view, label: commercialViewLabels[view] }))} />
      <section className="commercial-view" aria-labelledby={`commercial-view-${controller.view}`}>
        <Typography.Title ref={viewHeadingRef} tabIndex={-1} id={`commercial-view-${controller.view}`} level={4}>{commercialViewLabels[controller.view]}</Typography.Title>
        {renderView(controller.view, controller)}
      </section>
    </Space>
  );
}
