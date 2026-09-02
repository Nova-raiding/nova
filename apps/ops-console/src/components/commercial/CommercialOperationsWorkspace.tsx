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
  const revision = errorRevision(error.details);
  return <div ref={summaryRef} className="commercial-error-summary" role="alert" tabIndex={-1} aria-labelledby="commercial-error-title">
    <Alert
      type={conflict ? "warning" : "error"}
      showIcon
      title={<span id="commercial-error-title">{conflict ? "Revision conflict · 409" : `当前视图 UNAVAILABLE · ${error.code}`}</span>}
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
      {state.status === "error" && state.error ? <CommercialErrorSummary error={state.error} onRetry={onRetry} /> : null}
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
  const visible = (items: CommercialCatalogItem[]) => controller.permissions.privateSkuReadable ? items : items.filter(item => item.visibility !== "private");
  const permittedItems = useMemo(() => visible(state.data?.items ?? []), [state.data?.items, controller.permissions.privateSkuReadable]);
  const items = useMemo(() => filteredRows(permittedItems, controller), [permittedItems, controller.query.query]);
  const selection = useDeepLinkedSelection(items, controller);
  return <DataBoundary state={state} capability={commercialViewCapability.catalog} onRetry={() => void controller.loadView("catalog")}>{() => <><MissingRecordAlert record={selection.missingRecord} controller={controller} /><TableToolbar total={items.length} controller={controller} onRefresh={() => void controller.loadView("catalog")} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "商业目录版本") }} dataSource={items} scroll={{ x: 1540 }} columns={[
    { title: "SKU", dataIndex: "skuCode", fixed: "left", width: 180, sorter: (a, b) => a.skuCode.localeCompare(b.skuCode), ...controlledSort(controller, "skuCode"), render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "名称", dataIndex: "name", width: 180 }, { title: "类型", dataIndex: "type", width: 150 },
    { title: "可见性", dataIndex: "visibility", width: 110, render: value => <StateTag value={value} /> }, { title: "版本", dataIndex: "version", width: 130, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "价格 / 周期", width: 180, render: (_, row) => `${row.priceLabel}${row.cycleLabel ? ` / ${row.cycleLabel}` : ""}` }, { title: "权益摘要", dataIndex: "benefitsSummary", width: 300 },
    { title: "审批 / 生效", dataIndex: "approvalState", width: 150, render: value => <StateTag value={value} /> }, { title: "生效时间", dataIndex: "validFrom", width: 180, render: time },
    { title: "未决项", dataIndex: "unresolved", width: 220, render: value => value.length ? <Typography.Text type="danger">{value.join("、")}</Typography.Text> : "—" },
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
  {controller.permissions.canReconcilePayment ? <Alert type="warning" showIcon title="支付对账写入 API 尚未接入" description="页面不会把 payment success 伪装成 grant 或 RECOVERED；命令接口就绪前保持 BLOCKED。" /> : null}</>}</DataBoundary>;
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
  {controller.permissions.canWriteService ? <Alert type="warning" showIcon title="履约写入 API 尚未接入" description="在服务端提供独立 capability、reason、revision 和审计契约前保持只读 BLOCKED。" /> : null}</>}</DataBoundary>;
}

function renderView(view: CommercialView, controller: CommercialOperationsController) {
  if (view === "blocks") return <BlockTable state={controller.data.blocks} controller={controller} />;
  if (view === "entitlements") return <EntitlementTable state={controller.data.entitlements} controller={controller} />;
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
