import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Skeleton,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CommercialAccessBlock,
  CommercialAccessSummary,
  CommercialCatalogItem,
  CommercialEntitlement,
  CommercialOrderItem,
  CreativePointLedgerEntry,
  CreativePointRateItem,
  ServiceFulfillmentItem,
  CommercialTimelineEvent,
  CommercialRefundKind,
} from "../../api/commercialOperationsClient.js";
import {
  commercialViewCapability,
  commercialViewLabels,
  commercialViews,
  type CommercialDataState,
  type CommercialOperationsController,
  type CommercialView,
} from "../../hooks/useCommercialOperations.js";
import { refundPolicyApproval } from "../../api/commercialOperationsClient.js";
import { PointAdjustmentPanel } from "./PointAdjustmentPanel.js";
import { ServiceFulfillmentPanel } from "./ServiceFulfillmentPanel.js";

const dash = (value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "—" : String(value);
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "—";
const point = (value: number | null | undefined) => value === null || value === undefined ? "未知" : value.toLocaleString();

function StateTag({ value, semanticValue }: { value: string; semanticValue?: string }) {
  const normalized = (semanticValue ?? value).toLowerCase();
  const color = normalized.includes("recover") || normalized.includes("allow") || normalized === "paid" || normalized.includes("approved") || normalized === "active"
    ? "success"
    : normalized.includes("unknown") || normalized.includes("unavailable") || normalized.includes("failed") || normalized.includes("exhaust") || normalized.includes("blocked")
      ? "error"
      : normalized.includes("pending") || normalized.includes("stale") || normalized.includes("insufficient") || normalized.includes("draft")
        ? "warning" : "default";
  const icon = color === "success" ? <CheckCircleOutlined aria-hidden="true" />
    : color === "error" ? <CloseCircleOutlined aria-hidden="true" />
      : color === "warning" ? <WarningOutlined aria-hidden="true" /> : <ClockCircleOutlined aria-hidden="true" />;
  return <Tag icon={icon} color={color}>{value}</Tag>;
}

export function commercialBlockDisplayState(value: Pick<CommercialAccessBlock, "state" | "paymentState" | "grantState">): string {
  if (value.paymentState?.toLowerCase() === "paid" && value.grantState?.toLowerCase() !== "granted") return "PAID_BUT_UNGRANTED";
  return value.state;
}

function errorRevision(details?: Readonly<Record<string, unknown>>): string | null {
  if (!details) return null;
  const oldRevision = details.expected_revision ?? details.old_revision ?? details.client_revision;
  const newRevision = details.current_revision ?? details.new_revision ?? details.server_revision;
  if (oldRevision === undefined && newRevision === undefined) return null;
  return `客户端 revision ${dash(oldRevision as string | number | null)}；服务端 revision ${dash(newRevision as string | number | null)}`;
}

export function CommercialErrorSummary({ error, onRetry }: { error: NonNullable<CommercialDataState<unknown>["error"]>; onRetry: () => void }) {
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => { summaryRef.current?.focus({ preventScroll: false }); }, [error]);
  const conflict = error.httpStatus === 409 || error.code.includes("CONFLICT");
  const forbidden = error.httpStatus === 403 || error.code === "FORBIDDEN" || error.code === "HTTP_403";
  const unavailableStatus = error.httpStatus === 503 ? "503" : "UNAVAILABLE";
  const revision = errorRevision(error.details);
  return <div ref={summaryRef} className="commercial-error-summary" role="alert" tabIndex={-1} aria-labelledby="commercial-error-title">
    <Alert
      type={conflict ? "warning" : "error"}
      showIcon
      title={<span id="commercial-error-title">{conflict ? "Revision conflict · 409" : forbidden ? `当前视图 FORBIDDEN · 403` : `当前视图 ${unavailableStatus} · ${error.code}`}</span>}
      description={<Space orientation="vertical" size={2}>
        <span>{error.message}</span>
        {revision ? <Typography.Text>{revision}。已保留当前筛选与输入，请刷新后重新确认。</Typography.Text> : null}
        {error.requestId ? <Typography.Text code>request {error.requestId}</Typography.Text> : null}
        {error.traceId ? <Typography.Text code>trace {error.traceId}</Typography.Text> : null}
        {error.nextActions?.length ? <Typography.Text>服务端 next actions：{error.nextActions.map(String).join("、")}</Typography.Text> : null}
      </Space>}
      action={<Button onClick={onRetry}>重试</Button>}
    />
  </div>;
}

export function CommercialAccessStatusBar({ state, onRetry }: { state: CommercialDataState<CommercialAccessSummary>; onRetry: () => void }) {
  if (state.status === "forbidden") return <Alert type={state.error ? "warning" : "info"} showIcon title={state.error?.httpStatus === 403 ? "商业准入访问被拒绝 · 403" : "暂无商业准入数据"} description={state.error ? state.error.message : <>当前会话未授予 <Typography.Text code>commercial.access.read</Typography.Text>；服务端未返回商业准入数据，页面保持空状态。</>} />;
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
  if (state.status === "forbidden") return <Alert type={state.error ? "warning" : "info"} showIcon title={state.error?.httpStatus === 403 ? "当前视图访问被拒绝 · 403" : "暂无此视图数据"} description={state.error ? state.error.message : <>服务端未授予 <Typography.Text code>{capability}</Typography.Text>；未授权时不会发起数据请求，列表保持为空。</>} />;
  if ((state.status === "idle" || state.status === "loading") && !state.data) return <div aria-busy="true" aria-label="正在加载商业运营数据"><Skeleton active paragraph={{ rows: 8 }} /></div>;
  return (
    <Space orientation="vertical" size="middle" className="full-width">
      {state.status === "error" && state.error ? <>
        <CommercialErrorSummary error={state.error} onRetry={onRetry} />
        {state.data ? <Alert type="warning" showIcon title="以下为上次成功数据" description="当前服务端结果不可用，列表和数量不是实时结果，请勿据此执行账务操作。" /> : null}
      </> : null}
      {state.data ? children(state.data) : state.status === "error" ? null : <Empty description="服务端已返回空结果" />}
    </Space>
  );
}

function filteredRows<T>(items: readonly T[], controller: CommercialOperationsController): T[] {
  const term = controller.query.query.toLocaleLowerCase();
  const status = controller.query.status.toLocaleLowerCase();
  return items.filter((item) => {
    const row = item as Record<string, unknown>;
    if (status) {
      const values = [row.state, row.errorCode, row.status, row.paymentState, row.grantState, row.approvalState]
        .filter((value): value is string => typeof value === "string").map((value) => value.toLocaleLowerCase());
      if (!values.some((value) => value.includes(status))) return false;
    }
    return !term || Object.values(row).some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(term));
  });
}

function TableToolbar({ total, controller, onRefresh, showStatus = false }: { total: number; controller: CommercialOperationsController; onRefresh: () => void; showStatus?: boolean }) {
  return <div className="commercial-filter-bar">
    <Space wrap>
      <Input.Search
        allowClear
        value={controller.query.query}
        aria-label={`${commercialViewLabels[controller.view]}筛选当前已加载结果`}
        placeholder="筛选当前已加载结果"
        onChange={(event) => controller.setQuery({ query: event.target.value, page: 1 }, "replace")}
        className="commercial-search"
      />
      {showStatus ? <Select
        allowClear
        value={controller.query.status || undefined}
        aria-label="阻断状态筛选"
        placeholder="全部阻断状态"
        onChange={(value) => controller.setQuery({ status: value ?? "", page: 1 }, "replace")}
        options={["EXHAUSTED", "INSUFFICIENT", "UNAVAILABLE", "STALE", "RATE_CARD_UNAVAILABLE", "PAID_BUT_UNGRANTED", "RECOVERED"].map(value => ({ value, label: value }))}
        className="commercial-status-filter"
      /> : null}
      <Typography.Text type="secondary" aria-live="polite">当前显示 {total} 条</Typography.Text>
    </Space>
    <Button icon={<ReloadOutlined aria-hidden="true" />} onClick={onRefresh}>刷新</Button>
  </div>;
}

function emptyForFilter(controller: CommercialOperationsController, label: string) {
  const filtered = Boolean(controller.query.query || controller.query.status);
  return <Empty description={filtered ? `当前筛选没有${label}` : `服务端未返回${label}`}>
    {filtered ? <Button onClick={() => controller.setQuery({ query: "", status: "", page: 1 }, "replace")}>清除筛选</Button> : null}
  </Empty>;
}

function tablePagination(controller: CommercialOperationsController) {
  return { current: controller.query.page, pageSize: 20, showSizeChanger: false };
}

function updateTableState(controller: CommercialOperationsController, pagination: { current?: number }, _filters: unknown, sorter: unknown) {
  const value = Array.isArray(sorter) ? sorter[0] : sorter as { field?: string; order?: "ascend" | "descend" } | undefined;
  controller.setQuery({ page: pagination.current ?? 1, sort: value?.field ?? "", order: value?.order ?? "" }, "replace");
}

function controlledSort(controller: CommercialOperationsController, field: string) {
  const order = controller.query.sort === field ? controller.query.order : "";
  const ariaSort = order === "ascend" ? "ascending" : order === "descend" ? "descending" : "none";
  return {
    sortOrder: order || null,
    onHeaderCell: () => ({ "aria-sort": ariaSort as "ascending" | "descending" | "none" }),
  };
}

function useDeepLinkedSelection<T extends { id: string }>(items: readonly T[], controller: CommercialOperationsController) {
  const [selected, setSelected] = useState<T>();
  const [missingRecord, setMissingRecord] = useState("");
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!controller.query.record) { setSelected(undefined); setMissingRecord(""); return; }
    const match = items.find((item) => item.id === controller.query.record);
    if (match) { setSelected(match); setMissingRecord(""); }
    else { setSelected(undefined); setMissingRecord(controller.query.record); }
  }, [controller.query.record, items]);
  const open = (row: T, trigger: HTMLElement) => { triggerRef.current = trigger; setSelected(row); setMissingRecord(""); controller.setQuery({ record: row.id }); };
  const close = () => { setSelected(undefined); controller.setQuery({ record: "" }); };
  const afterOpenChange = (openState: boolean) => { if (!openState) requestAnimationFrame(() => triggerRef.current?.focus()); };
  return { selected, missingRecord, open, close, afterOpenChange };
}

function MissingRecordAlert({ record, controller }: { record: string; controller: CommercialOperationsController }) {
  return record ? <Alert role="alert" type="error" showIcon title="目标记录不可用" description={<>记录 <Typography.Text code>{record}</Typography.Text> 不存在、已越权或已不在当前 Workspace；未保留旧租户详情。</>} closable onClose={() => controller.setQuery({ record: "" }, "replace")} /> : null;
}

function BlockTable({ state, controller }: { state: CommercialOperationsController["data"]["blocks"]; controller: CommercialOperationsController }) {
  const items = useMemo(() => filteredRows(state.data?.items ?? [], controller), [state.data?.items, controller.query.query, controller.query.status]);
  const selection = useDeepLinkedSelection(items, controller);
  const selected = selection.selected;
  return <DataBoundary state={state} capability={commercialViewCapability.blocks} onRetry={() => void controller.loadView("blocks")}>{page => <>
    <MissingRecordAlert record={selection.missingRecord} controller={controller} />
    <TableToolbar total={items.length} controller={controller} showStatus onRefresh={() => void controller.loadView("blocks")} />
    <Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "商业阻断记录") }} dataSource={items} scroll={{ x: 1460 }} columns={[
      { title: "状态", dataIndex: "state", fixed: "left", width: 190, sorter: (a, b) => commercialBlockDisplayState(a).localeCompare(commercialBlockDisplayState(b)), ...controlledSort(controller, "state"), render: (_, row) => <StateTag value={commercialBlockDisplayState(row)} /> },
      { title: "Workspace", dataIndex: "workspaceId", fixed: "left", width: 190, sorter: (a, b) => a.workspaceId.localeCompare(b.workspaceId), ...controlledSort(controller, "workspaceId"), render: value => <Typography.Text className="ops-token" copyable>{value}</Typography.Text> },
      { title: "原因 code", dataIndex: "errorCode", width: 230, render: value => <Typography.Text code>{value}</Typography.Text> },
      { title: "可用 / 本次", width: 130, align: "right", render: (_, row) => `${point(row.availablePoints)} / ${point(row.quotedPoints)}` },
      { title: "Revision", dataIndex: "accessRevision", width: 150, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
      { title: "Payment / Grant", width: 190, render: (_, row) => `${dash(row.paymentState)} / ${dash(row.grantState)}` },
      { title: "发生时间", dataIndex: "occurredAt", width: 180, sorter: (a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)), ...controlledSort(controller, "occurredAt"), render: time },
      { title: "最后核验", dataIndex: "verifiedAt", width: 180, render: time },
      { title: "操作", fixed: "right", width: 140, render: (_, row) => <Button size="small" aria-label={`查看与恢复 ${row.workspaceId} ${row.errorCode}`} onClick={event => selection.open(row, event.currentTarget)}>查看与恢复</Button> },
    ]} />
    <Drawer title={selected ? `阻断详情 · ${selected.workspaceId}` : "阻断详情"} open={Boolean(selected)} size="large" onClose={selection.close} afterOpenChange={selection.afterOpenChange} destroyOnHidden>
      {selected ? <Space orientation="vertical" size="large" className="full-width">
        <Alert type={commercialBlockDisplayState(selected) === "RECOVERED" ? "success" : "error"} showIcon title={`${commercialBlockDisplayState(selected)} · ${selected.errorCode}`} description="支付成功不等于恢复；只有 grant 到账且新 CommercialAccessDecision 通过后才能标记 RECOVERED。" />
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

function EntitlementTable({ state, controller }: { state: CommercialOperationsController["data"]["entitlements"]; controller: CommercialOperationsController }) {
  const items = useMemo(() => filteredRows(state.data?.items ?? [], controller), [state.data?.items, controller.query.query]);
  const selection = useDeepLinkedSelection(items, controller);
  const reload = () => void controller.loadView("entitlements");
  return <DataBoundary state={state} capability={commercialViewCapability.entitlements} onRetry={reload}>{() => <><MissingRecordAlert record={selection.missingRecord} controller={controller} /><TableToolbar total={items.length} controller={controller} onRefresh={reload} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "Workspace 权益快照") }} dataSource={items} scroll={{ x: 1420 }} columns={[
    { title: "Workspace", dataIndex: "workspaceId", fixed: "left", width: 190, sorter: (a, b) => a.workspaceId.localeCompare(b.workspaceId), ...controlledSort(controller, "workspaceId"), render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "SKU", dataIndex: "skuCode", width: 160, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "快照版本", dataIndex: "snapshotVersion", width: 150, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "状态", dataIndex: "status", width: 120, render: value => <StateTag value={value} /> },
    { title: "品牌", dataIndex: "brandLimit", width: 90, align: "right", render: dash }, { title: "店铺", dataIndex: "storeLimit", width: 90, align: "right", render: dash },
    { title: "存储标签", dataIndex: "storageLabel", width: 130, render: dash }, { title: "服务权益", dataIndex: "serviceSummary", width: 220, render: dash },
    { title: "账期", dataIndex: "periodLabel", width: 170, render: dash }, { title: "来源订单", dataIndex: "sourceOrderId", width: 190, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
    { title: "更新时间", dataIndex: "updatedAt", width: 180, sorter: (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)), ...controlledSort(controller, "updatedAt"), render: time },
    { title: "操作", fixed: "right", width: 100, render: (_, row) => <Button size="small" aria-label={`查看 Workspace 权益 ${row.workspaceId} ${row.skuCode}`} onClick={event => selection.open(row, event.currentTarget)}>详情</Button> },
  ]} />
  <Drawer title="Workspace 权益快照" open={Boolean(selection.selected)} onClose={selection.close} afterOpenChange={selection.afterOpenChange} destroyOnHidden>{selection.selected ? <Descriptions bordered size="small" column={1} items={[
    { key: "workspace", label: "Workspace", children: <Typography.Text code>{selection.selected.workspaceId}</Typography.Text> },
    { key: "sku", label: "SKU / 快照", children: <Typography.Text code>{selection.selected.skuCode} / {selection.selected.snapshotVersion}</Typography.Text> },
    { key: "limits", label: "品牌 / 店铺", children: `${point(selection.selected.brandLimit)} / ${point(selection.selected.storeLimit)}` },
    { key: "storage", label: "存储原始标签", children: dash(selection.selected.storageLabel) },
    { key: "service", label: "服务权益", children: dash(selection.selected.serviceSummary) },
    { key: "order", label: "来源订单", children: <Typography.Text code>{dash(selection.selected.sourceOrderId)}</Typography.Text> },
  ]} /> : null}</Drawer></>}</DataBoundary>;
}

function LedgerTable({ state, controller }: { state: CommercialOperationsController["data"]["ledger"]; controller: CommercialOperationsController }) {
  const items = useMemo(() => filteredRows(state.data?.items ?? [], controller), [state.data?.items, controller.query.query]);
  const selection = useDeepLinkedSelection(items, controller);
  const selected = selection.selected;
  return <DataBoundary state={state} capability={commercialViewCapability.ledger} onRetry={() => void controller.loadView("ledger")}>{() => <><MissingRecordAlert record={selection.missingRecord} controller={controller} /><TableToolbar total={items.length} controller={controller} onRefresh={() => void controller.loadView("ledger")} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "创意点账本事件") }} dataSource={items} scroll={{ x: 1620 }} columns={[
    { title: "时间", dataIndex: "occurredAt", fixed: "left", width: 180, sorter: (a, b) => a.occurredAt.localeCompare(b.occurredAt), ...controlledSort(controller, "occurredAt"), render: time },
    { title: "事件", dataIndex: "eventType", width: 130, sorter: (a, b) => a.eventType.localeCompare(b.eventType), ...controlledSort(controller, "eventType"), render: value => <StateTag value={value} /> },
    { title: "点数增减", dataIndex: "pointsDelta", width: 110, align: "right", sorter: (a, b) => a.pointsDelta - b.pointsDelta, ...controlledSort(controller, "pointsDelta") },
    { title: "事件后投影", dataIndex: "balanceAfter", width: 120, align: "right", render: point },
    { title: "Workspace", dataIndex: "workspaceId", width: 190, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "来源", dataIndex: "source", width: 150 }, { title: "账期", dataIndex: "periodLabel", width: 150, render: dash },
    { title: "到期", dataIndex: "expiresAt", width: 180, render: time }, { title: "Operation", dataIndex: "operationId", width: 190, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
    { title: "状态", dataIndex: "status", width: 110, render: value => <StateTag value={value} /> },
    { title: "操作", fixed: "right", width: 100, render: (_, row) => <Button size="small" aria-label={`查看账本事件 ${row.id}`} onClick={event => selection.open(row, event.currentTarget)}>详情</Button> },
  ]} />
  <Drawer title="账本事件详情" open={Boolean(selected)} size="default" onClose={selection.close} afterOpenChange={selection.afterOpenChange} destroyOnHidden>{selected ? <Descriptions bordered size="small" column={1} items={[
    { key: "id", label: "事件 ID", children: <Typography.Text code>{selected.id}</Typography.Text> }, { key: "workspace", label: "Workspace", children: <Typography.Text code>{selected.workspaceId}</Typography.Text> },
    { key: "operation", label: "Operation", children: <Typography.Text code>{dash(selected.operationId)}</Typography.Text> }, { key: "actor", label: "Actor", children: <Typography.Text code>{dash(selected.actorId)}</Typography.Text> },
    { key: "key", label: "幂等键", children: <Typography.Text code>{dash(selected.idempotencyKey)}</Typography.Text> }, { key: "evidence", label: "证据", children: <Typography.Text code>{Object.keys(selected.evidence).length ? JSON.stringify(selected.evidence) : "未返回"}</Typography.Text> },
  ]} /> : null}</Drawer></>}</DataBoundary>;
}

function CatalogTable({ state, controller }: { state: CommercialOperationsController["data"]["catalog"]; controller: CommercialOperationsController }) {
  const typeLabel = (value: string) => ({ plan: "订阅套餐", trial: "试用套餐", point_pack: "点数包", onboarding_once: "一次性开通" }[value] ?? value);
  const visibilityLabel = (value: string) => ({ public: "公开售卖", private: "私测专用" }[value] ?? value);
  const approvalLabel = (value: string) => ({ active: "在售", approved: "已批准", draft: "草稿", archived: "已归档" }[value] ?? value);
  const visible = (items: CommercialCatalogItem[]) => controller.permissions.privateSkuReadable ? items : items.filter(item => item.visibility !== "private");
  const permittedItems = useMemo(() => visible(state.data?.items ?? []), [state.data?.items, controller.permissions.privateSkuReadable]);
  const items = useMemo(() => filteredRows(permittedItems, controller), [permittedItems, controller.query.query]);
  const selection = useDeepLinkedSelection(items, controller);
  return <DataBoundary state={state} capability={commercialViewCapability.catalog} onRetry={() => void controller.loadView("catalog")}>{() => <><MissingRecordAlert record={selection.missingRecord} controller={controller} /><TableToolbar total={items.length} controller={controller} onRefresh={() => void controller.loadView("catalog")} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "商业目录版本") }} dataSource={items} scroll={{ x: 1540 }} columns={[
    { title: "套餐", dataIndex: "name", fixed: "left", width: 250, sorter: (a, b) => a.name.localeCompare(b.name), ...controlledSort(controller, "name"), render: (value, row) => <Space orientation="vertical" size={0}><Typography.Text strong>{value}</Typography.Text><Typography.Text type="secondary" code copyable={{ text: row.skuCode }}>{row.skuCode}</Typography.Text><Typography.Text type="secondary">版本 {row.version}</Typography.Text></Space> },
    { title: "售卖形态", dataIndex: "type", width: 130, render: value => typeLabel(value) },
    { title: "价格方案", width: 190, render: (_, row) => <Space orientation="vertical" size={0}><Typography.Text strong>{row.priceLabel}</Typography.Text><Typography.Text type="secondary">{row.cycleLabel ?? "一次性"}</Typography.Text></Space> },
    { title: "包含权益", dataIndex: "benefitsSummary", width: 320, render: value => <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>{value}</Typography.Paragraph> },
    { title: "销售状态", dataIndex: "approvalState", width: 130, render: value => <StateTag value={approvalLabel(value)} semanticValue={value} /> },
    { title: "可见范围", dataIndex: "visibility", width: 120, render: value => <StateTag value={visibilityLabel(value)} semanticValue={value} /> },
    { title: "生效窗口", width: 190, render: (_, row) => <Space orientation="vertical" size={0}><Typography.Text>{row.validFrom ? time(row.validFrom) : "未开始"}</Typography.Text><Typography.Text type="secondary">{row.validTo ? `至 ${time(row.validTo)}` : "无截止"}</Typography.Text></Space> },
    { title: "风险 / 阻断", dataIndex: "unresolved", width: 250, render: value => value.length ? <Typography.Text type="danger">{value.join("、")}</Typography.Text> : <Typography.Text type="success">可执行条件已满足</Typography.Text> },
    { title: "操作", fixed: "right", width: 100, render: (_, row) => <Button size="small" aria-label={`查看目录 SKU ${row.skuCode} 版本 ${row.version}`} onClick={event => selection.open(row, event.currentTarget)}>详情</Button> },
  ]} />
  <Drawer title="目录版本详情" open={Boolean(selection.selected)} onClose={selection.close} afterOpenChange={selection.afterOpenChange} destroyOnHidden>{selection.selected ? <Descriptions bordered size="small" column={1} items={[
    { key: "sku", label: "SKU", children: <Typography.Text code>{selection.selected.skuCode}</Typography.Text> },
    { key: "version", label: "版本", children: <Typography.Text code>{selection.selected.version}</Typography.Text> },
    { key: "visibility", label: "可见性", children: <StateTag value={selection.selected.visibility} /> },
    { key: "price", label: "服务端价格 / 周期", children: `${selection.selected.priceLabel}${selection.selected.cycleLabel ? ` / ${selection.selected.cycleLabel}` : ""}` },
    { key: "benefits", label: "权益摘要", children: selection.selected.benefitsSummary },
    { key: "unresolved", label: "未决项", children: selection.selected.unresolved.length ? selection.selected.unresolved.join("、") : "无" },
  ]} /> : null}</Drawer>
  {!controller.permissions.canDraftCatalog ? <Alert type="info" showIcon title="目录只读" description="当前会话缺少 commercial.catalog.draft；不会渲染编辑表单。" /> : <Alert type="warning" showIcon title="目录写入 API 尚未接入" description="草稿、校验和发布命令在具备独立 capability、revision 与审计契约前保持 BLOCKED。" />}</>}</DataBoundary>;
}

function OrdersTable({ state, controller }: { state: CommercialOperationsController["data"]["orders"]; controller: CommercialOperationsController }) {
  const items = useMemo(() => filteredRows(state.data?.items ?? [], controller), [state.data?.items, controller.query.query]);
  const selection = useDeepLinkedSelection(items, controller);
  return <DataBoundary state={state} capability={commercialViewCapability.orders} onRetry={() => void controller.loadView("orders")}>{() => <><MissingRecordAlert record={selection.missingRecord} controller={controller} /><TableToolbar total={items.length} controller={controller} onRefresh={() => void controller.loadView("orders")} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "订单与支付记录") }} dataSource={items} scroll={{ x: 1600 }} columns={[
    { title: "订单号", dataIndex: "id", fixed: "left", width: 210, sorter: (a, b) => a.id.localeCompare(b.id), ...controlledSort(controller, "id"), render: value => <Typography.Text code copyable>{value}</Typography.Text> },
    { title: "Workspace", dataIndex: "workspaceId", width: 190, render: value => <Typography.Text code>{value}</Typography.Text> }, { title: "SKU / 版本", width: 210, render: (_, row) => <Typography.Text code>{row.skuCode} / {row.skuVersion}</Typography.Text> },
    { title: "购买点数", dataIndex: "purchasedPoints", width: 110, align: "right", render: point }, { title: "金额", dataIndex: "amountLabel", width: 130, align: "right" },
    { title: "渠道", dataIndex: "channel", width: 110, render: dash }, { title: "Payment", dataIndex: "paymentState", width: 130, render: value => <StateTag value={value} /> },
    { title: "Grant", dataIndex: "grantState", width: 130, render: value => <StateTag value={value} /> }, { title: "Access revision", dataIndex: "accessRevision", width: 150, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
    { title: "创建时间", dataIndex: "createdAt", width: 180, sorter: (a, b) => a.createdAt.localeCompare(b.createdAt), ...controlledSort(controller, "createdAt"), render: time }, { title: "支付时间", dataIndex: "paidAt", width: 180, render: time },
    { title: "操作", fixed: "right", width: 100, render: (_, row) => <Button size="small" aria-label={`查看订单 ${row.id}`} onClick={event => selection.open(row, event.currentTarget)}>详情</Button> },
  ]} />
  <Drawer title="订单、支付与 Grant 证据" open={Boolean(selection.selected)} onClose={selection.close} afterOpenChange={selection.afterOpenChange} destroyOnHidden>{selection.selected ? <Space orientation="vertical" className="full-width">
    {selection.selected.paymentState.toLowerCase() === "paid" && selection.selected.grantState.toLowerCase() !== "granted" ? <Alert role="alert" type="error" showIcon title="PAID_BUT_UNGRANTED" description="支付已确认，但 Grant 尚未到账；必须完成对账并取得新的 access revision 才能恢复。" /> : null}
    <Descriptions bordered size="small" column={1} items={[
      { key: "order", label: "订单", children: <Typography.Text code>{selection.selected.id}</Typography.Text> },
      { key: "workspace", label: "Workspace", children: <Typography.Text code>{selection.selected.workspaceId}</Typography.Text> },
      { key: "sku", label: "SKU / 版本", children: <Typography.Text code>{selection.selected.skuCode} / {selection.selected.skuVersion}</Typography.Text> },
      { key: "payment", label: "Payment / Grant", children: `${selection.selected.paymentState} / ${selection.selected.grantState}` },
      { key: "revision", label: "Access revision", children: <Typography.Text code>{dash(selection.selected.accessRevision)}</Typography.Text> },
      { key: "request", label: "Request ID", children: <Typography.Text code>{dash(selection.selected.requestId)}</Typography.Text> },
    ]} />
  </Space> : null}</Drawer>
  {controller.permissions.canReconcilePayment ? <Alert type="info" showIcon title="支付对账已接入" description="在下方‘私测转正式与人工转账’面板中核验普通订单或私测补差价；核验结果会返回支付、Grant 和 access revision 事实。" /> : null}</>}</DataBoundary>;
}

function RatesTable({ state, controller }: { state: CommercialOperationsController["data"]["rates"]; controller: CommercialOperationsController }) {
  const items = useMemo(() => filteredRows(state.data?.items ?? [], controller), [state.data?.items, controller.query.query]);
  return <DataBoundary state={state} capability={commercialViewCapability.rates} onRetry={() => void controller.loadView("rates")}>{() => <><TableToolbar total={items.length} controller={controller} onRefresh={() => void controller.loadView("rates")} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "创意点费率版本") }} dataSource={items} scroll={{ x: 1260 }} columns={[
    { title: "Action", dataIndex: "actionCode", fixed: "left", width: 240, sorter: (a, b) => a.actionCode.localeCompare(b.actionCode), ...controlledSort(controller, "actionCode"), render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "动作", dataIndex: "actionLabel", width: 180 }, { title: "单位", dataIndex: "unitLabel", width: 120 }, { title: "点数规则", dataIndex: "pointsRule", width: 180 },
    { title: "版本", dataIndex: "version", width: 140, render: value => <Typography.Text code>{value}</Typography.Text> }, { title: "审批状态", dataIndex: "approvalState", width: 160, render: value => <StateTag value={value} /> },
    { title: "生效窗口", width: 280, render: (_, row) => `${time(row.validFrom)} — ${time(row.validTo)}` }, { title: "阻断原因", dataIndex: "blockingReason", width: 220, render: dash },
  ]} />
  {controller.permissions.canDraftRate || controller.permissions.canApproveRate ? <Alert type="warning" showIcon title="费率治理命令 API 尚未接入" description="未批准或变量缺失的费率继续显示 RATE_CARD_UNAVAILABLE，不提供生产确认按钮。" /> : <Alert type="info" showIcon title="费率只读" description="当前会话没有费率草稿或审批 capability。" />}</>}</DataBoundary>;
}

function ServicesTable({ state, controller }: { state: CommercialOperationsController["data"]["services"]; controller: CommercialOperationsController }) {
  const items = useMemo(() => filteredRows(state.data?.items ?? [], controller), [state.data?.items, controller.query.query]);
  return <DataBoundary state={state} capability={commercialViewCapability.services} onRetry={() => void controller.loadView("services")}>{() => <><TableToolbar total={items.length} controller={controller} onRefresh={() => void controller.loadView("services")} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "服务履约记录") }} dataSource={items} scroll={{ x: 1320 }} columns={[
    { title: "Workspace", dataIndex: "workspaceId", fixed: "left", width: 190, sorter: (a, b) => a.workspaceId.localeCompare(b.workspaceId), ...controlledSort(controller, "workspaceId"), render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "服务类型", dataIndex: "serviceType", width: 160 }, { title: "分配量", dataIndex: "allocationLabel", width: 130 }, { title: "已用量", dataIndex: "usedLabel", width: 130 },
    { title: "排期", dataIndex: "scheduleAt", width: 180, sorter: (a, b) => String(a.scheduleAt).localeCompare(String(b.scheduleAt)), ...controlledSort(controller, "scheduleAt"), render: time }, { title: "状态", dataIndex: "status", width: 120, render: value => <StateTag value={value} /> },
    { title: "负责人", dataIndex: "ownerLabel", width: 150, render: dash }, { title: "证据", dataIndex: "evidenceLabel", width: 260, render: dash }, { title: "更新时间", dataIndex: "updatedAt", width: 180, render: time },
  ]} />
  {controller.permissions.canWriteService ? <Alert type="info" showIcon title="履约写入已接入" description="使用下方履约操作面板创建分配、排期、开始、完成或调整；每个动作都要求 revision、幂等键、原因和证据。" /> : null}</>}</DataBoundary>;
}

function TimelineTable({ state, controller }: { state: CommercialOperationsController["data"]["timeline"]; controller: CommercialOperationsController }) {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const items = useMemo(() => filteredRows(state.data?.items ?? [], controller).filter((item) => {
    const at = Date.parse(item.occurredAt);
    return (!fromDate || at >= Date.parse(`${fromDate}T00:00:00Z`)) && (!toDate || at <= Date.parse(`${toDate}T23:59:59.999Z`));
  }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), [state.data?.items, controller.query.query, controller.query.status, fromDate, toDate]);
  const selection = useDeepLinkedSelection(items, controller);
  return <DataBoundary state={state} capability={commercialViewCapability.timeline} onRetry={() => void controller.loadView("timeline")}>{() => <><MissingRecordAlert record={selection.missingRecord} controller={controller} /><TableToolbar total={items.length} controller={controller} onRefresh={() => void controller.loadView("timeline")} showStatus /><Space wrap><Typography.Text type="secondary">时间范围</Typography.Text><Input type="date" aria-label="时间范围起始" value={fromDate} onChange={event => setFromDate(event.target.value)} /><Typography.Text type="secondary">至</Typography.Text><Input type="date" aria-label="时间范围结束" value={toDate} onChange={event => setToDate(event.target.value)} /><Typography.Text type="secondary">Workspace：{controller.targetWorkspaceId || "未选择"}</Typography.Text></Space><Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} locale={{ emptyText: emptyForFilter(controller, "商业时间线事件") }} dataSource={items} scroll={{ x: 1540 }} columns={[
    { title: "时间", dataIndex: "occurredAt", fixed: "left", width: 190, render: time },
    { title: "事件", dataIndex: "kind", width: 220, render: value => <StateTag value={value} /> },
    { title: "状态", dataIndex: "status", width: 140, render: value => <StateTag value={value} /> },
    { title: "Workspace", dataIndex: "workspaceId", width: 180, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "Operation", dataIndex: "operationId", width: 190, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
    { title: "Trace", dataIndex: "traceId", width: 190, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
    { title: "操作者", dataIndex: "actorId", width: 150, render: dash },
    { title: "操作", fixed: "right", width: 90, render: (_, row) => <Button size="small" onClick={event => selection.open(row, event.currentTarget)} aria-label={`查看商业时间线事件 ${row.id}`}>详情</Button> },
  ]} /><Drawer title="商业时间线证据" open={Boolean(selection.selected)} onClose={selection.close} afterOpenChange={selection.afterOpenChange} destroyOnHidden>{selection.selected ? <Descriptions bordered size="small" column={1} items={[
    { key: "id", label: "事件 ID", children: <Typography.Text code>{selection.selected.id}</Typography.Text> },
    { key: "correlation", label: "Operation / Trace / Request", children: <Typography.Text code>{dash(selection.selected.operationId)} / {dash(selection.selected.traceId)} / {dash(selection.selected.requestId)}</Typography.Text> },
    { key: "actor", label: "操作者", children: dash(selection.selected.actorId) }, { key: "reason", label: "原因", children: dash(selection.selected.reason) },
    { key: "evidence", label: "证据", children: Object.keys(selection.selected.evidence).length ? <Typography.Text code>{JSON.stringify(selection.selected.evidence)}</Typography.Text> : "未返回" },
  ]} /> : null}</Drawer></>}</DataBoundary>;
}

function renderView(view: CommercialView, controller: CommercialOperationsController) {
  if (view === "blocks") return <BlockTable state={controller.data.blocks} controller={controller} />;
  if (view === "entitlements") return <EntitlementTable state={controller.data.entitlements} controller={controller} />;
  if (view === "ledger") return <LedgerTable state={controller.data.ledger} controller={controller} />;
  if (view === "catalog") return <CatalogTable state={controller.data.catalog} controller={controller} />;
  if (view === "orders") return <OrdersTable state={controller.data.orders} controller={controller} />;
  if (view === "rates") return <RatesTable state={controller.data.rates} controller={controller} />;
  if (view === "timeline") return <TimelineTable state={controller.data.timeline} controller={controller} />;
  return <ServicesTable state={controller.data.services} controller={controller} />;
}

function PrivateTrialOperationsPanel({ controller }: { controller: CommercialOperationsController }) {
  const canOperate = controller.permissions.canGrantPrivateSku || controller.permissions.canReconcilePayment;
  const [workspace, setWorkspace] = useState(controller.targetWorkspaceId);
  const [customerRef, setCustomerRef] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [eligibilityId, setEligibilityId] = useState("");
  const [trialOrderId, setTrialOrderId] = useState("");
  const [creditId, setCreditId] = useState("");
  const [conversionOrderId, setConversionOrderId] = useState("");
  const [paymentSubjectRef, setPaymentSubjectRef] = useState("");
  const [providerEventId, setProviderEventId] = useState("");
  const [providerOrderId, setProviderOrderId] = useState("");
  const [nonce, setNonce] = useState("");
  const [payloadHash, setPayloadHash] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  if (!canOperate) return <Alert type="info" showIcon title="私测转正式仅对授权运营人员开放" description="需要 commercial.private_sku.grant 或 commercial.payment.reconcile；无权限时不会发起请求。" />;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setMessage("");
    try { const value = await action(); setMessage(JSON.stringify(value)); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const reason = "商业化方案：私测转正式人工核验";
  return <section aria-label="私测转正式与人工转账" className="commercial-manual-operations">
    <Typography.Title level={5}>私测转正式 / 人工转账开通</Typography.Title>
    <Alert type="warning" showIcon message="正式开通 5000 元；1999 元仅为 7 天试用，验证后 7 天内补 3001 元，必须人工核验到账证据后开通。" description="每一步都会写入商业时间线和审计；不要只改前端状态。" />
    <Space wrap>
      <Input aria-label="目标 Workspace" placeholder="目标 Workspace" value={workspace} onChange={event => setWorkspace(event.target.value)} />
      <Input aria-label="客户标识" placeholder="客户标识" value={customerRef} onChange={event => setCustomerRef(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !customerRef} onClick={() => void run(async () => controller.client.createPrivateTrialInvite(workspace, customerRef, new Date(Date.now() + 7 * 86400000).toISOString(), reason))}>生成私测邀请</Button>
      <Input aria-label="私测邀请编码" placeholder="私测邀请编码（生成后粘贴/保存）" value={inviteCode} onChange={event => setInviteCode(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !customerRef || !inviteCode} onClick={() => void run(async () => { const value = await controller.client.createPrivateTrialEligibility(workspace, customerRef, inviteCode, reason); if (value && typeof value === "object") { const row = value as Record<string, unknown>; if (typeof row.eligibility_id === "string") setEligibilityId(row.eligibility_id); } return value; })}>使用邀请创建私测资格</Button>
      <Input aria-label="私测资格 ID" placeholder="私测资格 ID" value={eligibilityId} onChange={event => setEligibilityId(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !eligibilityId || !controller.permissions.canGrantPrivateSku} onClick={() => void run(() => controller.client.approvePrivateTrialEligibility(workspace, eligibilityId, revision, reason))}>业务审批</Button>
      <Button loading={busy} disabled={!workspace || !eligibilityId || !controller.permissions.canGrantPrivateSku} onClick={() => void run(async () => { const value = await controller.client.createPrivateTrialOrder(workspace, eligibilityId, "商业化方案：创建 1999 元私测订单"); if (value && typeof value === "object") { const row = value as Record<string, unknown>; const order = row.order; if (order && typeof order === "object" && typeof (order as Record<string, unknown>).order_id === "string") setTrialOrderId((order as Record<string, unknown>).order_id as string); } return value; })}>创建 1999 元私测订单</Button>
      <Button loading={busy} disabled={!workspace || !eligibilityId} onClick={() => void run(() => controller.client.completePrivateTrialValidation(workspace, eligibilityId, trialOrderId, new Date().toISOString(), reason))}>完成 7 天验证</Button>
      <Input aria-label="试用订单 ID" placeholder="试用订单 ID" value={trialOrderId} onChange={event => setTrialOrderId(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !eligibilityId || !controller.permissions.canGrantPrivateSku} onClick={() => void run(async () => { const value = await controller.client.preparePrivateTrialCredit(workspace, eligibilityId, reason); if (value && typeof value === "object") { const row = value as Record<string, unknown>; if (typeof row.credit_id === "string") setCreditId(row.credit_id); } return value; })}>准备 3001 元抵扣</Button>
      <Input aria-label="抵扣 ID" placeholder="抵扣 ID" value={creditId} onChange={event => setCreditId(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !creditId || !controller.permissions.canGrantPrivateSku} onClick={() => void run(() => controller.client.approvePrivateTrialCredit(workspace, creditId, reason))}>财务审批抵扣</Button>
      <Button loading={busy} disabled={!workspace || !creditId || !controller.permissions.canGrantPrivateSku} onClick={() => void run(async () => { const value = await controller.client.createPrivateTrialConversionOrder(workspace, creditId, reason); if (value && typeof value === "object") { const row = value as Record<string, unknown>; if (typeof row.order_id === "string") setConversionOrderId(row.order_id); } return value; })}>创建正式订单</Button>
      <Input aria-label="正式订单 ID" placeholder="正式订单 ID" value={conversionOrderId} onChange={event => setConversionOrderId(event.target.value)} />
      <Input aria-label="支付主体引用" placeholder="支付主体引用" value={paymentSubjectRef} onChange={event => setPaymentSubjectRef(event.target.value)} />
      <Input aria-label="支付事件 ID" placeholder="支付事件 ID" value={providerEventId} onChange={event => setProviderEventId(event.target.value)} />
      <Input aria-label="支付订单 ID" placeholder="支付订单 ID" value={providerOrderId} onChange={event => setProviderOrderId(event.target.value)} />
      <Input aria-label="支付 nonce" placeholder="支付 nonce" value={nonce} onChange={event => setNonce(event.target.value)} />
      <Input aria-label="支付 payload hash" placeholder="支付 payload hash" value={payloadHash} onChange={event => setPayloadHash(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !conversionOrderId || !paymentSubjectRef || !providerEventId || !providerOrderId || !nonce || !payloadHash || !controller.permissions.canReconcilePayment} onClick={() => void run(() => controller.client.verifyCommercialOrderTransfer(workspace, conversionOrderId, paymentSubjectRef, providerEventId, providerOrderId, nonce, payloadHash, new Date().toISOString(), reason))}>核验普通订单转账并发放点数</Button>
      <Button loading={busy} disabled={!workspace || !trialOrderId || !paymentSubjectRef || !providerEventId || !providerOrderId || !nonce || !payloadHash || !controller.permissions.canReconcilePayment} onClick={() => void run(() => controller.client.verifyPrivateTrialPayment(workspace, trialOrderId, paymentSubjectRef, providerEventId, providerOrderId, nonce, payloadHash, new Date().toISOString(), "商业化方案：核验 1999 元私测付款并授予试用权益"))}>核验 1999 元私测付款并授予权益</Button>
      <Button type="primary" loading={busy} disabled={!workspace || !creditId || !conversionOrderId || !paymentSubjectRef || !providerEventId || !providerOrderId || !nonce || !payloadHash || !controller.permissions.canReconcilePayment} onClick={() => void run(() => controller.client.verifyPrivateTrialTransfer(workspace, creditId, conversionOrderId, paymentSubjectRef, providerEventId, providerOrderId, nonce, payloadHash, new Date().toISOString(), reason))}>核验转账并开通</Button>
    </Space>
    {message ? <Typography.Paragraph copyable={{ text: message }} code>{message}</Typography.Paragraph> : null}
  </section>;
}

function CommercialRefundOperationsPanel({ controller }: { controller: CommercialOperationsController }) {
  const [workspace, setWorkspace] = useState(controller.targetWorkspaceId);
  const [orderId, setOrderId] = useState("");
  const [requestId, setRequestId] = useState("");
  const [amountFen, setAmountFen] = useState("");
  const [points, setPoints] = useState("0");
  const [refundKind, setRefundKind] = useState<CommercialRefundKind>("monthly_unused_points");
  const [requestEvidenceRef, setRequestEvidenceRef] = useState("");
  const [externalRefundId, setExternalRefundId] = useState("");
  const [policyApproval, setPolicyApproval] = useState('{"legal_review_ref":""}');
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  let policyApprovalReady = false;
  try { refundPolicyApproval(policyApproval); policyApprovalReady = true; } catch { /* invalid evidence stays disabled */ }
  if (!controller.permissions.canReconcilePayment) return null;
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setMessage(""); try { setMessage(JSON.stringify(await action())); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const reason = "商业化方案：订单退款人工审核";
  return <section aria-label="商业订单退款" className="commercial-manual-operations">
    <Typography.Title level={5}>商业订单退款 / 点数回滚</Typography.Title>
    <Alert type="warning" showIcon message="退款必须经过双人审批、法律/补充协议证据和外部支付退款凭证；不会因为前端点击直接退款。" />
    <Space wrap>
      <Input aria-label="退款目标 Workspace" placeholder="目标 Workspace" value={workspace} onChange={event => setWorkspace(event.target.value)} />
      <Input aria-label="退款订单 ID" placeholder="订单 ID" value={orderId} onChange={event => setOrderId(event.target.value)} />
      <Input aria-label="退款请求 ID" placeholder="退款请求 ID（幂等）" value={requestId} onChange={event => setRequestId(event.target.value)} />
      <Input aria-label="退款金额（分）" placeholder="退款金额（分）" value={amountFen} onChange={event => setAmountFen(event.target.value)} />
      <Input aria-label="回滚创意点" placeholder="回滚创意点，默认 0" value={points} onChange={event => setPoints(event.target.value)} />
      <Select aria-label="退款类型" value={refundKind} onChange={value => setRefundKind(value)} options={[
        { value: "onboarding_pre_deployment", label: "部署前实施费" }, { value: "monthly_unused_points", label: "月费未使用点数" }, { value: "point_pack_unused_points", label: "点数包未使用点数" }, { value: "outage_compensation", label: "故障补偿" }, { value: "custom_milestone", label: "定制里程碑" },
      ]} />
      <Input aria-label="退款申请证据引用" placeholder={refundKind === "monthly_unused_points" ? "补充协议编号" : refundKind === "point_pack_unused_points" ? "到期政策编号" : refundKind === "outage_compensation" ? "事故 ID" : refundKind === "custom_milestone" ? "里程碑 ID" : "部署前自动记录 not_started"} value={requestEvidenceRef} disabled={refundKind === "onboarding_pre_deployment"} onChange={event => setRequestEvidenceRef(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !orderId || !requestId || !amountFen || (refundKind !== "onboarding_pre_deployment" && !requestEvidenceRef.trim())} onClick={() => void run(() => controller.client.requestCommercialRefund({ workspace, orderId, requestId, kind: refundKind, amountFen: Number(amountFen), pointsToRevoke: Number(points || "0"), reason, evidenceRef: requestEvidenceRef }))}>提交退款申请</Button>
      <Input aria-label="政策审批证据 JSON" placeholder="政策审批证据 JSON" value={policyApproval} onChange={event => setPolicyApproval(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !requestId || !policyApprovalReady} onClick={() => void run(() => controller.client.approveCommercialRefund(workspace, requestId, policyApproval, reason))}>双人审批</Button>
      <Input aria-label="外部退款凭证" placeholder="外部退款凭证 / 转账流水号" value={externalRefundId} onChange={event => setExternalRefundId(event.target.value)} />
      <Button type="primary" loading={busy} disabled={!workspace || !requestId || !externalRefundId} onClick={() => void run(() => controller.client.completeCommercialRefund(workspace, requestId, externalRefundId, JSON.stringify({ source: "ops_console", action: "external_refund_verified" }), reason))}>登记退款并回滚点数</Button>
    </Space>
    {message ? <Typography.Paragraph copyable={{ text: message }} code>{message}</Typography.Paragraph> : null}
  </section>;
}

export function CommercialOperationsWorkspace({ controller }: { controller: CommercialOperationsController }) {
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { viewHeadingRef.current?.focus({ preventScroll: true }); }, [controller.view]);
  return (
    <Space orientation="vertical" size="middle" className="full-width commercial-operations-workspace">
      <CommercialAccessStatusBar state={controller.summary} onRetry={() => void controller.loadSummary()} />
      <PrivateTrialOperationsPanel controller={controller} />
      <CommercialRefundOperationsPanel controller={controller} />
      <PointAdjustmentPanel controller={controller} />
      <ServiceFulfillmentPanel controller={controller} />
      <Tabs activeKey={controller.view} onChange={key => controller.setView(key as CommercialView)} items={commercialViews.map(view => ({ key: view, label: commercialViewLabels[view] }))} />
      <section className="commercial-view" aria-labelledby={`commercial-view-${controller.view}`}>
        <Typography.Title ref={viewHeadingRef} tabIndex={-1} id={`commercial-view-${controller.view}`} level={4}>{commercialViewLabels[controller.view]}</Typography.Title>
        {renderView(controller.view, controller)}
      </section>
    </Space>
  );
}
