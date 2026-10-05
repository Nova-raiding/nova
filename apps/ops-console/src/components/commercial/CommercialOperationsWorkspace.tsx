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
  CommercialRefundEvent,
  CommercialPage,
  CommercialCashReceipt,
  CommercialAllocationPreview,
  CommercialCashReturn,
  AssistedOrderInput,
  AssistedOrderPreview,
  AssistedCheckoutPreview,
  AssistedUpgradeQuote,
  CashAllocationLine,
  CashAllocationBatchPreview,
  UnmatchedCashReceipt,
  UnmatchedReceiptRecordInput,
  CashRecoveryIntent,
} from "../../api/commercialOperationsClient.js";
import {
  commercialViewCapability,
  commercialViewLabels,
  commercialViews,
  type CommercialDataState,
  type CommercialOperationsController,
  type CommercialView,
} from "../../hooks/useCommercialOperations.js";
import { positiveCommercialFen, provisionableCatalogItems, parseAssistedUpgradeQuote, refundPolicyApproval, recoverCashIntent } from "../../api/commercialOperationsClient.js";
import { DangerActionModal } from "../authz/DangerActionModal.js";
import { PointAdjustmentPanel } from "./PointAdjustmentPanel.js";
import { ServiceFulfillmentPanel } from "./ServiceFulfillmentPanel.js";
import {
  CommercialOperationOutcomeAlert,
  commercialOperationDecision,
  idleCommercialOperationOutcome,
  settleCommercialOperation,
  type CommercialOperationId,
  type CommercialOperationOutcome,
  type PendingCommercialOperation,
} from "./commercialOperationFeedback.js";
import { readableBenefits } from "./benefitLabels.js";
import { packageCodeLabel, packageDisplayName } from "./packageLabels.js";
import { describeOpsError } from "../../api/opsClient.js";
import { yuanToFen } from "../../utils/currency.js";

const dash = (value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "—" : String(value);
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "—";
const point = (value: number | null | undefined) => value === null || value === undefined ? "待确认" : value.toLocaleString();

export const platformCatalogGovernanceTarget = {
  id: "ops-platform-catalog",
  href: "?workbench=platform#ops-platform-catalog",
} as const;

const commercialStateLabels: Record<string, string> = {
  paid: "已核验支付",
  pending: "待处理",
  unpaid: "未支付",
  failed: "失败",
  closed: "已关闭",
  granted: "权益已授予",
  ungranted: "尚未授予",
  active: "生效中",
  expired: "已过期",
  revoked: "已撤回",
  suspended: "已暂停",
  blocked: "已阻断",
};

const readableCommercialState = (value: string | null | undefined) => {
  if (!value) return "待确认";
  return commercialStateLabels[value.toLowerCase()] ?? value;
};

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

function TableToolbar({ total, controller, onRefresh, showStatus = false, truncated = false }: { total: number; controller: CommercialOperationsController; onRefresh: () => void; showStatus?: boolean; truncated?: boolean }) {
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
      <Typography.Text type={truncated ? "warning" : "secondary"} aria-live="polite">{truncated ? `当前显示 ${total} 条，服务端仍有未加载记录` : `当前显示 ${total} 条`}</Typography.Text>
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

function tablePagination(controller: CommercialOperationsController, total?: number) {
  return { current: controller.query.page, pageSize: 20, ...(total === undefined ? {} : { total }), showSizeChanger: false };
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
    <TableToolbar total={items.length} truncated={state.data?.truncated === true} controller={controller} showStatus onRefresh={() => void controller.loadView("blocks")} />
    <Table rowKey="id" size="small" sticky pagination={tablePagination(controller, state.data?.total)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "商业阻断记录") }} dataSource={items} scroll={{ x: 1460 }} columns={[
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
  return <DataBoundary state={state} capability={commercialViewCapability.entitlements} onRetry={reload}>{() => <><MissingRecordAlert record={selection.missingRecord} controller={controller} />
    <Alert type="info" showIcon title="标准套餐权益由订单自动授予" description="这里展示服务端已经授予企业工作区的权益快照。正常购买不需要运营逐项勾选权限；只有赠送、补偿、退款回收或定制合同等例外，才进入单独的人工审批流程。" />
    <TableToolbar total={items.length} truncated={state.data?.truncated === true} controller={controller} onRefresh={reload} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller, state.data?.total)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "企业工作区权益快照") }} dataSource={items} scroll={{ x: 1530 }} columns={[
    { title: "企业工作区", dataIndex: "workspaceId", fixed: "left", width: 190, sorter: (a, b) => a.workspaceId.localeCompare(b.workspaceId), ...controlledSort(controller, "workspaceId"), render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "套餐", dataIndex: "skuCode", width: 190, render: value => <Space orientation="vertical" size={0}><Typography.Text>{packageDisplayName(value)}</Typography.Text><Typography.Text type="secondary" code>{value}</Typography.Text></Space> },
    { title: "快照版本", dataIndex: "snapshotVersion", width: 150, render: value => <Typography.Text code>{value}</Typography.Text> },
    { title: "权益状态", dataIndex: "status", width: 120, render: value => <StateTag value={readableCommercialState(value)} semanticValue={value} /> },
    { title: "品牌", dataIndex: "brandLimit", width: 90, align: "right", render: dash }, { title: "店铺", dataIndex: "storeLimit", width: 90, align: "right", render: dash },
    { title: "存储空间", dataIndex: "storageLabel", width: 130, render: dash }, { title: "服务权益", dataIndex: "serviceSummary", width: 220, render: dash },
    { title: "有效账期", dataIndex: "periodLabel", width: 170, render: dash }, { title: "授予来源", width: 210, render: (_, row) => row.sourceOrderId ? <Space orientation="vertical" size={0}><Typography.Text>套餐自动授予</Typography.Text><Typography.Text type="secondary" code>{row.sourceOrderId}</Typography.Text></Space> : <Typography.Text type="secondary">人工/合同，待核对</Typography.Text> },
    { title: "更新时间", dataIndex: "updatedAt", width: 180, sorter: (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)), ...controlledSort(controller, "updatedAt"), render: time },
    { title: "操作", fixed: "right", width: 100, render: (_, row) => <Button size="small" aria-label={`查看 Workspace 权益 ${row.workspaceId} ${row.skuCode}`} onClick={event => selection.open(row, event.currentTarget)}>详情</Button> },
  ]} />
  <Drawer title="企业工作区权益快照" open={Boolean(selection.selected)} onClose={selection.close} afterOpenChange={selection.afterOpenChange} destroyOnHidden>{selection.selected ? <Descriptions bordered size="small" column={1} items={[
    { key: "workspace", label: "企业工作区", children: <Typography.Text code>{selection.selected.workspaceId}</Typography.Text> },
    { key: "sku", label: "套餐 / 快照", children: <Space orientation="vertical" size={0}><Typography.Text>{packageDisplayName(selection.selected.skuCode)}</Typography.Text><Typography.Text type="secondary" code>{selection.selected.skuCode} / {selection.selected.snapshotVersion}</Typography.Text></Space> },
    { key: "limits", label: "品牌 / 店铺", children: `${point(selection.selected.brandLimit)} / ${point(selection.selected.storeLimit)}` },
    { key: "storage", label: "存储空间", children: dash(selection.selected.storageLabel) },
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

function CatalogTable({ state, controller, catalogGovernanceHref }: { state: CommercialOperationsController["data"]["catalog"]; controller: CommercialOperationsController; catalogGovernanceHref: string }) {
  const typeLabel = (value: string) => ({ plan: "订阅套餐", trial: "试用套餐", point_pack: "点数包", onboarding_once: "一次性开通" }[value] ?? value);
  const visibilityLabel = (value: string) => ({ public: "公开售卖", private: "私测专用" }[value] ?? value);
  const approvalLabel = (value: string) => ({ active: "在售", approved: "已批准", draft: "草稿", archived: "已归档" }[value] ?? value);
  const visible = (items: CommercialCatalogItem[]) => controller.permissions.privateSkuReadable ? items : items.filter(item => item.visibility !== "private");
  const permittedItems = useMemo(() => visible(state.data?.items ?? []), [state.data?.items, controller.permissions.privateSkuReadable]);
  const items = useMemo(() => filteredRows(permittedItems, controller), [permittedItems, controller.query.query]);
  const selection = useDeepLinkedSelection(items, controller);
  return <DataBoundary state={state} capability={commercialViewCapability.catalog} onRetry={() => void controller.loadView("catalog")}>{() => <><MissingRecordAlert record={selection.missingRecord} controller={controller} /><TableToolbar total={items.length} controller={controller} onRefresh={() => void controller.loadView("catalog")} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "商业目录版本") }} dataSource={items} scroll={{ x: 1540 }} columns={[
    { title: "套餐", dataIndex: "skuCode", fixed: "left", width: 250, sorter: (a, b) => a.skuCode.localeCompare(b.skuCode), ...controlledSort(controller, "skuCode"), render: (value, row) => <Space orientation="vertical" size={0}><Typography.Text strong>{packageDisplayName(value, row.name)}</Typography.Text><Typography.Text type="secondary" code copyable={{ text: value }}>{packageCodeLabel(value)}</Typography.Text><Typography.Text type="secondary">版本 {row.version}</Typography.Text></Space> },
    { title: "售卖形态", dataIndex: "type", width: 130, render: value => typeLabel(value) },
    { title: "价格方案", width: 190, render: (_, row) => <Space orientation="vertical" size={0}><Typography.Text strong>{row.priceLabel}</Typography.Text><Typography.Text type="secondary">{row.cycleLabel ?? "一次性"}</Typography.Text></Space> },
    { title: "套餐权益", dataIndex: "benefitsSummary", width: 360, render: (_value, row) => <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>{readableBenefits(row)}</Typography.Paragraph> },
    { title: "销售状态", dataIndex: "approvalState", width: 130, render: value => <StateTag value={approvalLabel(value)} semanticValue={value} /> },
    { title: "可见范围", dataIndex: "visibility", width: 120, render: value => <StateTag value={visibilityLabel(value)} semanticValue={value} /> },
    { title: "生效窗口", width: 190, render: (_, row) => <Space orientation="vertical" size={0}><Typography.Text>{row.validFrom ? time(row.validFrom) : "未开始"}</Typography.Text><Typography.Text type="secondary">{row.validTo ? `至 ${time(row.validTo)}` : "无截止"}</Typography.Text></Space> },
    { title: "风险 / 阻断", dataIndex: "unresolved", width: 250, render: value => value.length ? <Typography.Text type="danger">{value.join("、")}</Typography.Text> : <Typography.Text type="success">可执行条件已满足</Typography.Text> },
    { title: "操作", fixed: "right", width: 100, render: (_, row) => <Button size="small" aria-label={`查看目录 SKU ${row.skuCode} 版本 ${row.version}`} onClick={event => selection.open(row, event.currentTarget)}>详情</Button> },
  ]} />
  <Drawer title="目录版本详情" open={Boolean(selection.selected)} onClose={selection.close} afterOpenChange={selection.afterOpenChange} destroyOnHidden>{selection.selected ? <Descriptions bordered size="small" column={1} items={[
    { key: "sku", label: "套餐", children: <Space orientation="vertical" size={0}><Typography.Text>{packageDisplayName(selection.selected.skuCode, selection.selected.name)}</Typography.Text><Typography.Text type="secondary" code>{packageCodeLabel(selection.selected.skuCode)}</Typography.Text></Space> },
    { key: "version", label: "版本", children: <Typography.Text code>{selection.selected.version}</Typography.Text> },
    { key: "visibility", label: "可见性", children: <StateTag value={selection.selected.visibility} /> },
    { key: "price", label: "服务端价格 / 周期", children: `${selection.selected.priceLabel}${selection.selected.cycleLabel ? ` / ${selection.selected.cycleLabel}` : ""}` },
    { key: "benefits", label: "套餐权益", children: readableBenefits(selection.selected) },
    { key: "unresolved", label: "未决项", children: selection.selected.unresolved.length ? selection.selected.unresolved.join("、") : "无" },
  ]} /> : null}</Drawer>
  {!controller.permissions.canDraftCatalog ? <Alert type="info" showIcon title="目录只读" description="当前会话缺少 commercial.catalog.draft；不会渲染编辑表单。" /> : <Alert
    type="success"
    showIcon
    title="套餐目录治理已可用"
    description="当前 Workspace 视图用于核对目录版本；草稿、审批、发布和停售统一在平台财务中心的套餐管理中执行，并保留版本与审计记录。"
    action={<Button type="link" href={catalogGovernanceHref}>打开套餐管理</Button>}
  />}</>}</DataBoundary>;
}

function OrdersTable({ state, controller }: { state: CommercialOperationsController["data"]["orders"]; controller: CommercialOperationsController }) {
  const items = useMemo(() => filteredRows(state.data?.items ?? [], controller), [state.data?.items, controller.query.query]);
  const selection = useDeepLinkedSelection(items, controller);
  return <DataBoundary state={state} capability={commercialViewCapability.orders} onRetry={() => void controller.loadView("orders")}>{() => <><MissingRecordAlert record={selection.missingRecord} controller={controller} /><TableToolbar total={items.length} truncated={state.data?.truncated === true} controller={controller} onRefresh={() => void controller.loadView("orders")} /><Table rowKey="id" size="small" sticky pagination={tablePagination(controller, state.data?.total)} onChange={(pagination, filters, sorter) => updateTableState(controller, pagination, filters, sorter)} locale={{ emptyText: emptyForFilter(controller, "订单与支付记录") }} dataSource={items} scroll={{ x: 1600 }} columns={[
    { title: "订单号", dataIndex: "id", fixed: "left", width: 210, sorter: (a, b) => a.id.localeCompare(b.id), ...controlledSort(controller, "id"), render: value => <Typography.Text code copyable>{value}</Typography.Text> },
    { title: "企业工作区", dataIndex: "workspaceId", width: 190, render: value => <Typography.Text code>{value}</Typography.Text> }, { title: "套餐 / 版本", width: 230, render: (_, row) => <Space orientation="vertical" size={0}><Typography.Text>{packageDisplayName(row.skuCode)}</Typography.Text><Typography.Text type="secondary" code>{row.skuCode} / {row.skuVersion}</Typography.Text></Space> },
    { title: "购买点数", dataIndex: "purchasedPoints", width: 110, align: "right", render: point }, { title: "金额", dataIndex: "amountLabel", width: 130, align: "right" },
    { title: "支付渠道", dataIndex: "channel", width: 110, render: dash }, { title: "支付状态", dataIndex: "paymentState", width: 130, render: value => <StateTag value={readableCommercialState(value)} semanticValue={value} /> },
    { title: "权益发放", dataIndex: "grantState", width: 130, render: value => <StateTag value={readableCommercialState(value)} semanticValue={value} /> }, { title: "权限版本", dataIndex: "accessRevision", width: 150, render: value => <Typography.Text code>{dash(value)}</Typography.Text> },
    { title: "创建时间", dataIndex: "createdAt", width: 180, sorter: (a, b) => a.createdAt.localeCompare(b.createdAt), ...controlledSort(controller, "createdAt"), render: time }, { title: "支付时间", dataIndex: "paidAt", width: 180, render: time },
    { title: "操作", fixed: "right", width: 100, render: (_, row) => <Button size="small" aria-label={`查看订单 ${row.id}`} onClick={event => selection.open(row, event.currentTarget)}>详情</Button> },
  ]} />
  <Drawer title="订单、支付与权益证据" open={Boolean(selection.selected)} onClose={selection.close} afterOpenChange={selection.afterOpenChange} destroyOnHidden>{selection.selected ? <Space orientation="vertical" className="full-width">
    {selection.selected.paymentState.toLowerCase() === "paid" && selection.selected.grantState.toLowerCase() !== "granted" ? <Alert role="alert" type="error" showIcon title="已支付但权益未到账" description="支付已确认，但套餐权益尚未授予；必须完成对账并取得新的权限版本后才能恢复服务。" /> : null}
    <Descriptions bordered size="small" column={1} items={[
      { key: "order", label: "订单", children: <Typography.Text code>{selection.selected.id}</Typography.Text> },
      { key: "workspace", label: "Workspace", children: <Typography.Text code>{selection.selected.workspaceId}</Typography.Text> },
      { key: "sku", label: "套餐 / 版本", children: <Space orientation="vertical" size={0}><Typography.Text>{packageDisplayName(selection.selected.skuCode)}</Typography.Text><Typography.Text type="secondary" code>{selection.selected.skuCode} / {selection.selected.skuVersion}</Typography.Text></Space> },
      { key: "payment", label: "支付 / 权益", children: `${readableCommercialState(selection.selected.paymentState)} / ${readableCommercialState(selection.selected.grantState)}` },
      { key: "revision", label: "权限版本", children: <Typography.Text code>{dash(selection.selected.accessRevision)}</Typography.Text> },
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

function renderView(view: CommercialView, controller: CommercialOperationsController, catalogGovernanceHref: string) {
  if (view === "blocks") return <BlockTable state={controller.data.blocks} controller={controller} />;
  if (view === "entitlements") return <EntitlementTable state={controller.data.entitlements} controller={controller} />;
  if (view === "ledger") return <LedgerTable state={controller.data.ledger} controller={controller} />;
  if (view === "catalog") return <CatalogTable state={controller.data.catalog} controller={controller} catalogGovernanceHref={catalogGovernanceHref} />;
  if (view === "orders") return <OrdersTable state={controller.data.orders} controller={controller} />;
  if (view === "rates") return <RatesTable state={controller.data.rates} controller={controller} />;
  if (view === "timeline") return <TimelineTable state={controller.data.timeline} controller={controller} />;
  return <ServicesTable state={controller.data.services} controller={controller} />;
}

const cashLabel = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const intentKey = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const cashStateLabel = (state: string) => ({ requested: "待审批", approved: "已批准待返款", pending_external: "返款处理中", external_unknown: "外部结果待确认，资金冻结", completed: "已核实返款", rejected: "已拒绝", partially_received: "部分到账", fully_received: "款项已足额分配", verification_required: "待核验订单依赖及授予" }[state] ?? readableCommercialState(state));

const contractSummary = (value: unknown): string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "当前无生效合同";
  const row = value as { skuCode?: string; periodStart?: string; periodEnd?: string; sourceOrderId?: string; periodStatus?: string };
  return `${row.skuCode ?? "套餐"}；${time(row.periodStart)} 至 ${time(row.periodEnd)}；${readableCommercialState(row.periodStatus ?? "unknown")}；来源订单 ${row.sourceOrderId ?? "待核实"}`;
};
const cycleSummary = (value: unknown): string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "一次性权益，期限以冻结条款为准";
  const row = value as { unit?: string; count?: number };
  return typeof row.count === "number" ? `${row.count}${row.unit === "month" ? "个自然月" : row.unit === "day" ? "天" : "期"}` : "周期待核实";
};
const benefitsSummary = (value: unknown): string => Array.isArray(value) ? value.map(item => {
  if (!item || typeof item !== "object") return "权益明细待核实";
  const row = item as { name?: string; code?: string; quantity?: number; normalizedValue?: number; rawUnit?: string };
  return `${row.name ?? row.code ?? "权益"}：${row.quantity ?? row.normalizedValue ?? "按批准条款"}${row.rawUnit ?? ""}`;
}).join("；") : "权益待核实";

export function AssistedPurchaseOperationsPanel({ controller }: { controller: CommercialOperationsController }) {
  const workspace = controller.targetWorkspaceId;
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<Array<{ workspaceId: string; memberId: string; customerId: string; name: string; enterpriseName: string | null; workspaceStatus?: string | null; status: string }>>([]);
  const [customer, setCustomer] = useState("");
  const [skuCode, setSkuCode] = useState("");
  const [kind, setKind] = useState<AssistedOrderInput["purchaseKind"] | "first_purchase">("first_purchase");
  const [onboardingSkuCode, setOnboardingSkuCode] = useState("");
  const [checkoutPreview, setCheckoutPreview] = useState<AssistedCheckoutPreview>();
  const [reason, setReason] = useState("");
  const [quote, setQuote] = useState<AssistedUpgradeQuote>();
  const [preview, setPreview] = useState<AssistedOrderPreview>();
  const [intent, setIntent] = useState<{ key: string; kind: "order" | "quote" | "checkout" }>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const generation = useRef(0);
  const triggerRef = useRef<HTMLElement | null>(null);
  const catalog = controller.data.catalog.status === "ready" ? provisionableCatalogItems(controller.data.catalog.data?.items ?? []) : [];
  const selected = customers.find(row => `${row.memberId}:${row.workspaceId}` === customer && row.workspaceId === workspace && row.status === "active" && row.workspaceStatus === "active");
  const sku = catalog.find(row => row.skuCode === skuCode);
  useEffect(() => {
    generation.current++; setPreview(undefined); setCheckoutPreview(undefined); setQuote(undefined); setIntent(undefined); setUnknown(false); setConfirming(false); setBusy(false); setError(""); setResult("");
    try { const saved = sessionStorage.getItem(`commercial-purchase-intent:${workspace}`); if (saved) { const value = JSON.parse(saved) as { key?: string; kind?: string }; if (typeof value.key === "string" && ["order", "quote", "checkout"].includes(value.kind ?? "")) { setIntent(value as { key: string; kind: "order" | "quote" | "checkout" }); setUnknown(true); } } } catch { /* malformed storage does not trigger a purchase */ }
  }, [workspace]);
  const invalidate = () => { setPreview(undefined); setCheckoutPreview(undefined); setQuote(undefined); };
  const remember = (value: { key: string; kind: "order" | "quote" | "checkout" }) => { setIntent(value); try { sessionStorage.setItem(`commercial-purchase-intent:${workspace}`, JSON.stringify(value)); } catch { /* in-memory key remains stable */ } };
  const clearIntent = () => { setIntent(undefined); setUnknown(false); try { sessionStorage.removeItem(`commercial-purchase-intent:${workspace}`); } catch { /* stale marker fails closed */ } };
  const failure = (value: unknown, write = false) => {
    const status = (value as { httpStatus?: number }).httpStatus;
    const uncertain = write && (!status || status >= 500);
    setError(`${describeOpsError(value)}${uncertain ? " 原提交结果待确认，禁止另建订单或再次付款。" : " 请刷新客户、目录和报价后重新预览。"}`); setUnknown(uncertain); setConfirming(false);
    if (!uncertain) { clearIntent(); setPreview(undefined); }
  };
  const recover = async () => {
    if (!intent || busy) return;
    const version = generation.current; setBusy(true); setError("");
    try {
      const value = intent.kind === "quote" ? await controller.client.getAssistedQuoteRequest(workspace, intent.key) : intent.kind === "checkout" ? await controller.client.getAssistedCheckoutRequest(workspace,intent.key) : await controller.client.getAssistedOrderRequest(workspace, intent.key);
      if (version !== generation.current) return;
      if (!value || typeof value !== "object") throw new Error("原请求结果仍未确认；请联系对账负责人，禁止重付");
      if (intent.kind === "quote") { const recovered = parseAssistedUpgradeQuote(value); if (recovered.workspaceId !== workspace) throw new Error("原报价企业不匹配"); setQuote(recovered); setSkuCode(recovered.targetSkuCode); setKind("upgrade"); }
      else if (intent.kind === "checkout") { const row = value as {checkout_id?:unknown;orders?:Array<{order_id?:unknown;workspace_id?:unknown}>}; if (typeof row.checkout_id !== "string" || !Array.isArray(row.orders) || row.orders.length !== 2 || row.orders.some(order => typeof order.order_id !== "string" || order.workspace_id !== workspace)) throw new Error("首购全部订单仍需核对，禁止新购或重复付款"); }
      else { const row = value as { order_id?: unknown; workspace_id?: unknown }; if (typeof row.order_id !== "string" || row.workspace_id !== workspace) throw new Error("原订单结果尚未被核实；保留原意图并联系对账负责人"); }
      setResult("已查询原提交结果；请刷新订单及依赖状态，勿再次付款。"); clearIntent(); await controller.loadView("orders");
    } catch (value) { if (version === generation.current) { setError(describeOpsError(value)); setUnknown(true); } }
    finally { if (version === generation.current) setBusy(false); }
  };
  const submit = async () => {
    const approved = checkoutPreview ?? preview;
    if (!approved || !intent || !["order","checkout"].includes(intent.kind) || busy || unknown || approved.workspaceId !== workspace || approved.reason !== reason || Date.parse(approved.expiresAt) <= Date.now()) return;
    const version = generation.current; setBusy(true); setError(""); remember(intent);
    try {
      if (!selected) throw new Error("指定客户成员已不再有效，请重新查询");
      if (checkoutPreview) await controller.client.createAssistedCheckout({ workspace,beneficiaryMemberId:selected.memberId,onboardingSkuCode:checkoutPreview.lines.find(line => line.kind === "onboarding_once")!.skuCode,subscriptionSkuCode:checkoutPreview.lines.find(line => line.kind === "purchase")!.skuCode,reason:checkoutPreview.reason,previewHash:checkoutPreview.previewHash,idempotencyKey:intent.key });
      else if (preview) await controller.client.createAssistedOrder({ workspace,beneficiaryMemberId:selected.memberId, skuCode: preview.skuCode, purchaseKind: preview.purchaseKind, ...(quote ? { upgradeQuoteId: quote.id } : {}), reason: preview.reason, previewHash: preview.previewHash, idempotencyKey: intent.key });
      if (version !== generation.current) return;
      clearIntent(); setConfirming(false); setPreview(undefined); setCheckoutPreview(undefined); setResult("订单已创建。真实到账、依赖校验和权益授予仍分别核验，建单不代表已开通。"); await controller.loadView("orders");
    } catch (value) { if (version === generation.current) failure(value, true); }
    finally { if (version === generation.current) setBusy(false); }
  };
  if (!controller.permissions.canReadOrders && !controller.permissions.canCreateOrder && !controller.permissions.canSearchCustomers) return null;
  return <section aria-label="指定客户代购"><Space orientation="vertical" size="middle" className="full-width">
    <Typography.Title level={4}>为指定客户代购套餐或权益包</Typography.Title>
    <Alert type="info" showIcon title="先核对客户与企业，再确认服务器价格" description="开户邀请请使用用户管理的授权开户流程。开通费与首期套餐分别计费；建单不等于到账或权益生效。升级补差价保持原合同到期时间。" />
    <Space wrap><Input aria-label="查找代购客户" placeholder="客户姓名、账号或企业" value={search} onChange={event => setSearch(event.target.value)} disabled={busy || unknown} /><Button disabled={!controller.permissions.canSearchCustomers || !search.trim() || busy || unknown} onClick={() => { const version = generation.current; setBusy(true); void controller.client.searchPurchaseCustomers(search).then(value => { if (version === generation.current) setCustomers(value); }).catch(value => { if (version === generation.current) setError(describeOpsError(value)); }).finally(() => { if (version === generation.current) setBusy(false); }); }}>查询真实客户</Button>
    <Select aria-label="指定客户和企业" style={{ minWidth: 340 }} value={customer || undefined} placeholder="明确选择 active 客户及其 active 企业" disabled={busy || unknown} options={customers.map(row => ({ value: `${row.memberId}:${row.workspaceId}`, label: `${row.name} · ${row.enterpriseName ?? row.workspaceId} · 账号 ${row.status} / 企业 ${row.workspaceStatus ?? "未核实"}`, disabled: row.status !== "active" || row.workspaceStatus !== "active" }))} onChange={value => { const row = customers.find(item => `${item.memberId}:${item.workspaceId}` === value); if (!row || row.status !== "active" || row.workspaceStatus !== "active") return; setCustomer(value); controller.setTargetWorkspace(row.workspaceId); invalidate(); }} />
    <Button disabled={!workspace || busy || unknown || !controller.permissions.canReadOrders} onClick={() => { invalidate(); void Promise.all([controller.loadView("catalog"), controller.loadView("orders"), controller.loadView("entitlements")]); }}>读取当前目录和合同</Button></Space>
    <Typography.Text>目标企业：{workspace || "未选择"}；客户：{selected?.name ?? "尚未核实客户与企业匹配"}</Typography.Text>
    <Space wrap><Select aria-label="代购购买意图" style={{ minWidth: 180 }} value={kind} disabled={busy || unknown || confirming} options={[{ value: "first_purchase", label: "首购：开通费加首期" }, { value: "purchase", label: "购买套餐" }, { value: "renewal", label: "续购套餐" }, { value: "upgrade", label: "按剩余有效期升级" }, { value: "point_pack", label: "购买点数权益包" }]} onChange={value => { setKind(value); setSkuCode(""); invalidate(); }} />
    <Select aria-label="当前上架代购商品" style={{ minWidth: 340 }} value={skuCode || undefined} placeholder="选择当前真正上架的商品版本" disabled={busy || unknown || confirming} options={catalog.filter(row => kind === "point_pack" ? row.type === "point_pack" : row.type === "monthly").map(row => ({ value: row.skuCode, label: `${row.name} · ${row.priceLabel} · ${row.cycleLabel ?? (row.durationDays ? `${row.durationDays}天有效` : "周期以服务端快照为准")}` }))} onChange={value => { setSkuCode(value); invalidate(); }} />
    {kind === "first_purchase" ? <Select aria-label="当前上架开通费用" style={{minWidth:260}} value={onboardingSkuCode || undefined} placeholder="选择当前上架开通费版本" disabled={busy || unknown || confirming} options={catalog.filter(row => row.type === "onboarding").map(row => ({value:row.skuCode,label:`${row.name} · ${row.priceLabel}`}))} onChange={value => {setOnboardingSkuCode(value);invalidate();}} /> : null}
    <Input aria-label="代购操作原因" placeholder="代购原因和客户授权引用" value={reason} disabled={busy || unknown || confirming} onChange={event => { setReason(event.target.value); setPreview(undefined); setCheckoutPreview(undefined); }} /></Space>
    {kind === "upgrade" ? <Button disabled={!selected || !sku || !controller.permissions.canCreateOrder || busy || unknown} onClick={() => { const version = generation.current; const next = { key: intentKey("ops_upgrade_quote"), kind: "quote" as const }; remember(next); setBusy(true); setError(""); void controller.client.createAssistedUpgradeQuote(workspace, skuCode, next.key).then(value => { if (version === generation.current) { if (value.workspaceId !== workspace || value.targetSkuCode !== skuCode) throw new Error("升级报价与目标客户或商品不匹配"); setQuote(value); clearIntent(); setPreview(undefined); } }).catch(value => { if (version === generation.current) failure(value, true); }).finally(() => { if (version === generation.current) setBusy(false); }); }}>读取服务器冻结升级报价</Button> : null}
    {quote ? <Descriptions bordered size="small" column={2}><Descriptions.Item label="当前/目标周期价格">{cashLabel(quote.currentCyclePriceFen)} / {cashLabel(quote.targetCyclePriceFen)}</Descriptions.Item><Descriptions.Item label="按剩余期补差价">{cashLabel(quote.amountFen)}</Descriptions.Item><Descriptions.Item label="原合同有效期">{time(quote.periodStart)} 至 {time(quote.periodEnd)}</Descriptions.Item><Descriptions.Item label="报价截止">{time(quote.expiresAt)}</Descriptions.Item><Descriptions.Item label="剩余有效期占比">{Math.floor(quote.remainingMs / 86400000)} 天 {Math.floor(quote.remainingMs % 86400000 / 3600000)} 小时（{(quote.remainingMs / quote.totalMs * 100).toFixed(2)}%）</Descriptions.Item><Descriptions.Item label="增量权益">{benefitsSummary(quote.benefitIncrements)}</Descriptions.Item></Descriptions> : null}
    <Button disabled={!selected || !sku || !reason.trim() || !controller.permissions.canReadOrders || busy || unknown || (kind === "first_purchase" && !onboardingSkuCode) || (kind === "upgrade" && (!quote || Date.parse(quote.expiresAt) <= Date.now()))} onClick={() => { if (!selected) return; const version = generation.current; setBusy(true); setError(""); const request = kind === "first_purchase" ? controller.client.previewAssistedCheckout({workspace,beneficiaryMemberId:selected.memberId,onboardingSkuCode,subscriptionSkuCode:skuCode,reason}) : controller.client.previewAssistedOrder({workspace,beneficiaryMemberId:selected.memberId,skuCode,purchaseKind:kind,reason,...(quote ? {upgradeQuoteId:quote.id} : {})}); void request.then(value => { if (version !== generation.current) return; if (value.workspaceId !== workspace || value.reason !== reason) throw new Error("服务端预览与所选客户或企业不匹配"); if ("lines" in value) { if (value.lines.find(line => line.kind === "purchase")?.skuCode !== skuCode || value.lines.find(line => line.kind === "onboarding_once")?.skuCode !== onboardingSkuCode) throw new Error("首购明细与选择不匹配"); setCheckoutPreview(value); setPreview(undefined); setIntent({key:intentKey("ops_checkout"),kind:"checkout"}); } else { if (value.skuCode !== skuCode) throw new Error("商品不匹配"); setPreview(value); setCheckoutPreview(undefined); setIntent({key:intentKey("ops_order"),kind:"order"}); } }).catch(value => {if (version === generation.current) failure(value);}).finally(() => {if (version === generation.current) setBusy(false);}); }}>读取服务端代购预览</Button>
    {checkoutPreview ? <><Descriptions bordered size="small" column={2}><Descriptions.Item label="当前已购合同">{contractSummary(checkoutPreview.current)}</Descriptions.Item><Descriptions.Item label="已购未来合同">{checkoutPreview.future.length ? checkoutPreview.future.map(contractSummary).join("；") : "无已购未来合同"}</Descriptions.Item></Descriptions>{checkoutPreview.onboardingQualified ? <Alert type="warning" showIcon title="客户已满足开通资格，请选择购买、续购或升级，不重复收开通费" /> : null}<Table rowKey="kind" size="small" pagination={false} dataSource={checkoutPreview.lines} columns={[{title:"费用类型",dataIndex:"kind",render:(value:string) => value === "onboarding_once" ? "一次开通费" : "首期套餐（依赖开通费）"},{title:"冻结商品",dataIndex:"name"},{title:"冻结版本",dataIndex:"versionId"},{title:"本行金额",dataIndex:"amountFen",render:cashLabel},{title:"周期",dataIndex:"cycle",render:cycleSummary},{title:"权益",dataIndex:"benefits",render:benefitsSummary}]} /><Typography.Text strong>合计 {cashLabel(checkoutPreview.amountFen)}；开通费不包含首期费用；确认截止 {time(checkoutPreview.expiresAt)}</Typography.Text><Button type="primary" disabled={!controller.permissions.canCreateOrder || busy || unknown || !selected || checkoutPreview.onboardingQualified || Date.parse(checkoutPreview.expiresAt) <= Date.now()} onClick={event => {triggerRef.current=event.currentTarget;setConfirming(true);}}>确认开通费加首期联合代购</Button></> : null}
    {preview ? <><Descriptions bordered column={2} size="small"><Descriptions.Item label="目标客户/企业">{selected?.name} / {preview.workspaceId}</Descriptions.Item><Descriptions.Item label="冻结商品/版本">{preview.name} / {preview.versionId}</Descriptions.Item><Descriptions.Item label="本次订单金额">{cashLabel(preview.amountFen)}</Descriptions.Item><Descriptions.Item label="周期">{cycleSummary(preview.cycle)}</Descriptions.Item><Descriptions.Item label="权益">{benefitsSummary(preview.benefits)}</Descriptions.Item><Descriptions.Item label="开通依赖">{preview.onboardingQualified ? "已满足开通资格" : "尚未满足，请使用开通费与首期联合购买"}</Descriptions.Item><Descriptions.Item label="当前合同">{contractSummary(preview.current)}</Descriptions.Item><Descriptions.Item label="未来合同">{preview.future.length ? preview.future.map(contractSummary).join("；") : "无已购未来合同"}</Descriptions.Item></Descriptions><Button type="primary" disabled={!controller.permissions.canCreateOrder || busy || unknown || !selected || !preview.onboardingQualified || Date.parse(preview.expiresAt) <= Date.now()} onClick={event => { triggerRef.current = event.currentTarget; setConfirming(true); }}>确认代购 {cashLabel(preview.amountFen)}</Button></> : null}
    {error ? <Alert type="error" showIcon title={unknown ? "原结果待确认" : "代购未完成"} description={error} /> : null}{result ? <Alert type="info" role="status" title={result} /> : null}
    {unknown ? <Alert type="warning" showIcon title="保留原请求，禁止重付" description={`原意图 ${intent?.key ?? "待查询"}；查询完成前不会创建第二笔。`} action={<Button disabled={busy || !intent} onClick={() => void recover()}>查询原请求结果</Button>} /> : null}
    <DangerActionModal open={confirming && !unknown} title="确认指定客户代购" objectLabel="客户、企业与冻结商品" objectValue={`${selected?.name ?? "未核实"} / ${workspace} / ${checkoutPreview ? "开通费及首期两行" : preview?.name ?? ""} / ${cashLabel(checkoutPreview?.amountFen ?? preview?.amountFen ?? 0)}`} scope={`workspace:${workspace}`} impact="只创建待支付订单；款项到账、合同依赖与实际授予另行核验。" reason={reason} onReasonChange={value => { if (value !== reason) { setReason(value); setPreview(undefined); setCheckoutPreview(undefined); setConfirming(false); } }} onConfirm={submit} onCancel={() => { if (!busy) setConfirming(false); }} loading={busy} error={error || undefined} initialFocus="cancel" triggerRef={triggerRef} />
  </Space></section>;
}

export function UnmatchedCashOperationsPanel({ controller }: { controller: CommercialOperationsController }) {
  const permissions = controller.permissions;
  const [rows,setRows] = useState<UnmatchedCashReceipt[]>([]);
  const [cursor,setCursor] = useState<string | null>(null);
  const [fresh,setFresh] = useState(false);
  const [receiptId,setReceiptId] = useState("");
  const [search,setSearch] = useState("");
  const [customers,setCustomers] = useState<Awaited<ReturnType<typeof controller.client.searchPurchaseCustomers>>>([]);
  const [customerKey,setCustomerKey] = useState("");
  const [receiver,setReceiver] = useState("");
  const [tradeId,setTradeId] = useState("");
  const [payer,setPayer] = useState("");
  const [amount,setAmount] = useState("");
  const [receivedAt,setReceivedAt] = useState("");
  const [evidence,setEvidence] = useState("");
  const [reason,setReason] = useState("");
  const [error,setError] = useState("");
  const [result,setResult] = useState("");
  const [busy,setBusy] = useState(false);
  const [unknown,setUnknown] = useState(false);
  const [recoveryKey,setRecoveryKey] = useState("");
  const [recovery,setRecovery] = useState<CashRecoveryIntent>();
  const [returns,setReturns] = useState<CommercialCashReturn[]>([]);
  const [returnCursor,setReturnCursor] = useState<string|null>(null);
  const [returnId,setReturnId] = useState("");
  const [externalReturnId,setExternalReturnId] = useState("");
  const [pending,setPending] = useState<{key:string;label:string;summary:string;recovery:CashRecoveryIntent;run:(confirmedReason:string)=>Promise<unknown>}>();
  const triggerRef = useRef<HTMLElement | null>(null);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true; try { const saved=sessionStorage.getItem("commercial-unmatched-intent"); if(saved) { const entry=JSON.parse(saved) as {key?:string;recovery?:CashRecoveryIntent}; if(typeof entry.key === "string") {setRecoveryKey(entry.key);setRecovery(entry.recovery);setUnknown(true);} } } catch { /* no automatic retry */ } return () => {mounted.current=false;requestGeneration.current++;}; },[]);
  const selected = fresh ? rows.find(row=>row.id === receiptId) : undefined;
  const selectedCustomer = customers.find(row=>`${row.customerId}:${row.workspaceId}` === customerKey && row.status === "active" && row.workspaceStatus === "active");
  let amountFen:number | null=null; try {amountFen=positiveCommercialFen(amount);} catch { /* invalid financial input stays disabled */ }
  const loadPage = async (next?:string) => {
    const generation=++requestGeneration.current; setBusy(true);setFresh(false);setError("");setReceiptId("");
    try { const page=await controller.client.listUnmatchedReceipts({limit:50,...(next?{cursor:next}:{})}); if(!mounted.current || generation!==requestGeneration.current)return; setRows(page.items);setCursor(page.nextCursor ?? null);setFresh(true); }
    catch(value) {if(mounted.current && generation===requestGeneration.current)setError(describeOpsError(value));}
    finally {if(mounted.current && generation===requestGeneration.current)setBusy(false);}
  };
  const request = (label:string,summary:string,run:(confirmedReason:string)=>Promise<unknown>,trigger:HTMLElement,recovery:CashRecoveryIntent) => {triggerRef.current=trigger;setError("");setPending({key:recovery.key,label,summary,run,recovery});};
  const confirm = async () => {
    if(!pending || busy || unknown || !reason.trim())return;
    const generation=++requestGeneration.current;setBusy(true);setError("");setRecoveryKey(pending.key);setRecovery(pending.recovery);
    try {sessionStorage.setItem("commercial-unmatched-intent",JSON.stringify({key:pending.key,label:pending.label,recovery:pending.recovery}));} catch { /* in-memory original intent stays frozen */ }
    try { const value=await pending.run(reason.trim()); if(!mounted.current || generation!==requestGeneration.current)return;
      if(value && typeof value === "object" && "workspaceId" in value && typeof value.workspaceId === "string") controller.setTargetWorkspace(value.workspaceId);
      setPending(undefined);setUnknown(false);setRecoveryKey("");setRecovery(undefined);try{sessionStorage.removeItem("commercial-unmatched-intent");}catch{ /* stale recovery marker stays fail closed */ }
      setReturns([]);setReturnId("");setResult("服务端已记录收款/归属事实；匹配不代表已付款或已授予。请在目标企业读取原收款和订单，再分配核验。");await loadPage();
    } catch(value) {if(!mounted.current || generation!==requestGeneration.current)return;const status=(value as {httpStatus?:number}).httpStatus;const uncertain=!status || status>=500;setUnknown(uncertain);setError(`${describeOpsError(value)}${uncertain?" 保留原意图，结果待核实；禁止另登同笔款或匹配到另一个企业。":" 请刷新真实收款与客户信息后重新核对。"}`);if(!uncertain){setPending(undefined);setRecoveryKey("");try{sessionStorage.removeItem("commercial-unmatched-intent");}catch{ /* fail closed after reload */ }}}
    finally {if(mounted.current)setBusy(false);}
  };
  const selectedReturn=returns.find(row=>row.id===returnId);
  const loadReturns=async(next?:string)=>{const generation=++requestGeneration.current;setReturns([]);setReturnId("");setBusy(true);setError("");try{const page=await controller.client.listCashReturnPage(undefined,{limit:50,...(next?{cursor:next}:{})});if(!mounted.current||generation!==requestGeneration.current)return;setReturns(page.items);setReturnCursor(page.nextCursor??null);setReturnId("");}catch(value){if(mounted.current&&generation===requestGeneration.current)setError(describeOpsError(value));}finally{if(mounted.current&&generation===requestGeneration.current)setBusy(false);}};
  const recover=async()=>{if(!recovery){setError("旧会话没有原始事实，请由对账负责人核实原标识；不能猜测结果或另起意图。");return;}const generation=++requestGeneration.current;setBusy(true);setError("");try{const confirmed=await recoverCashIntent(controller.client,recovery);if(!mounted.current||generation!==requestGeneration.current)return;if(!confirmed){setError("原事实尚未确认或不一致；保持锁定和原标识，不重复收款/匹配/返款。");return;}sessionStorage.removeItem("commercial-unmatched-intent");setUnknown(false);setPending(undefined);setRecovery(undefined);setRecoveryKey("");setFresh(false);setRows([]);setReturns([]);setReturnId("");setResult("已按原始事实核实结果；没有发出新的付款或返款。请刷新队列和原返款状态。");}catch(value){if(mounted.current&&generation===requestGeneration.current)setError(describeOpsError(value));}finally{if(mounted.current&&generation===requestGeneration.current)setBusy(false);}};
  if(!permissions.canReadUnmatchedReceipts && !permissions.canRecordUnmatchedReceipts && !permissions.canMatchUnmatchedReceipts)return null;
  return <section aria-label="全局待匹配真实收款"><Space orientation="vertical" size="middle" className="full-width">
    <Typography.Title level={4}>全局待匹配银行收款</Typography.Title>
    <Alert type="info" showIcon title="归属未知先入受限待匹配队列" description="核实真实到账后登记，企业归属保持未知；不得创建演示企业、假已付订单或提前授予。匹配必须核对 active 客户及其 active 企业，并留归属证据。" />
    <Space wrap><Button disabled={!permissions.canReadUnmatchedReceipts || busy || Boolean(pending)&&!unknown} onClick={()=>void loadPage()}>从首页读取待匹配收款</Button><Button disabled={!permissions.canReadUnmatchedReceipts || !cursor || busy || Boolean(pending)&&!unknown} onClick={()=>{if(cursor)void loadPage(cursor);}}>读取下一页待匹配收款</Button><Typography.Text>每页最多50条；当前页 {fresh?rows.length:"尚未核实"} 条，{cursor?"还有下一页":"以服务端分页结果为准"}</Typography.Text></Space>
    {error?<Alert role="alert" type="error" showIcon title={unknown?"原结果待确认":"读取或操作未完成"} description={error}/>:null}{result?<Alert role="status" type="info" title={result}/>:null}
    {fresh?<Table rowKey="id" pagination={false} size="small" dataSource={rows} scroll={{x:1100}} columns={[{title:"原收款",dataIndex:"id"},{title:"真实银行流水",dataIndex:"externalTradeId"},{title:"收款账户",dataIndex:"receivingAccountRef"},{title:"原付款方",dataIndex:"payerRef"},{title:"实收",dataIndex:"amountFen",render:cashLabel},{title:"已返/冻结",render:(_:unknown,row:UnmatchedCashReceipt)=>`${cashLabel(row.returnedFen)} / ${cashLabel(row.frozenReturnFen)}`},{title:"可用余款",dataIndex:"availableFen",render:cashLabel},{title:"实际到账",dataIndex:"receivedAt",render:time}]} locale={{emptyText:"此页没有未匹配收款（真实服务器查询结果）"}}/>:<Typography.Text>尚未读取真实队列，不代表队列为空。</Typography.Text>}
    <Typography.Title level={5}>登记归属未知的已核实款项</Typography.Title>
    <Space wrap><Input aria-label="未知收款账户引用" placeholder="核实收款账户引用" value={receiver} disabled={busy||unknown||Boolean(pending)} onChange={event=>setReceiver(event.target.value)}/><Input aria-label="未知收款银行流水" placeholder="真实银行流水号" value={tradeId} disabled={busy||unknown||Boolean(pending)} onChange={event=>setTradeId(event.target.value)}/><Input aria-label="未知收款付款方" placeholder="原付款方" value={payer} disabled={busy||unknown||Boolean(pending)} onChange={event=>setPayer(event.target.value)}/><Input aria-label="未知收款实收金额（元）" placeholder="实际到账金额（元）" inputMode="decimal" value={amount} disabled={busy||unknown||Boolean(pending)} onChange={event=>setAmount(event.target.value)}/><Input aria-label="未知收款实际到账时间" type="datetime-local" value={receivedAt} disabled={busy||unknown||Boolean(pending)} onChange={event=>setReceivedAt(event.target.value)}/><Input aria-label="未知收款核实和归属证据" placeholder="核实/归属证据引用，不含完整凭证" value={evidence} disabled={busy||unknown||Boolean(pending)} onChange={event=>setEvidence(event.target.value)}/><Input aria-label="未知收款操作原因" placeholder="操作原因" value={reason} disabled={busy||unknown||Boolean(pending)} onChange={event=>setReason(event.target.value)}/>
    <Button disabled={!permissions.canRecordUnmatchedReceipts||busy||unknown||Boolean(pending)||amountFen===null||!receiver.trim()||!tradeId.trim()||!payer.trim()||!receivedAt||!Number.isFinite(Date.parse(receivedAt))||Date.parse(receivedAt)>Date.now()||!evidence.trim()||!reason.trim()} onClick={event=>{if(amountFen===null)return;const input:UnmatchedReceiptRecordInput={receivingAccountRef:receiver.trim(),externalTradeId:tradeId.trim(),payerRef:payer.trim(),amountFen,receivedAt:new Date(receivedAt).toISOString(),evidenceRef:evidence.trim(),reason:reason.trim()};request("确认登记待匹配收款",`收款账户 ${input.receivingAccountRef}；流水 ${input.externalTradeId}；付款方 ${input.payerRef}；实收 ${cashLabel(input.amountFen)}；实际到账 ${time(input.receivedAt)}；企业归属未知。只登记，不建单或授予。`,confirmedReason=>controller.client.recordUnmatchedReceipt({...input,reason:confirmedReason}),event.currentTarget,{key:intentKey("unmatched_record"),kind:"record",receivingAccountRef:input.receivingAccountRef,externalTradeId:input.externalTradeId,amountFen:input.amountFen,payerRef:input.payerRef,receivedAt:input.receivedAt});}}>预览待匹配到账事实</Button></Space>
    <Typography.Title level={5}>核对客户和企业后匹配原收款</Typography.Title>
    <Space wrap><Select aria-label="待匹配原收款" style={{minWidth:300}} value={receiptId||undefined} placeholder="选择本页真实待匹配收款" disabled={!fresh||busy||unknown||Boolean(pending)} options={rows.map(row=>({value:row.id,label:`${row.externalTradeId} · ${row.payerRef} · ${cashLabel(row.amountFen)}`}))} onChange={setReceiptId}/><Input aria-label="查询匹配客户" placeholder="客户账号、姓名或企业" value={search} disabled={busy||unknown||Boolean(pending)} onChange={event=>{setSearch(event.target.value);setCustomers([]);setCustomerKey("");}}/><Button disabled={!permissions.canSearchCustomers||!search.trim()||busy||unknown||Boolean(pending)} onClick={()=>{const generation=++requestGeneration.current;setBusy(true);setError("");void controller.client.searchPurchaseCustomers(search).then(value=>{if(mounted.current&&generation===requestGeneration.current){setCustomers(value);setCustomerKey("");}}).catch(value=>{if(mounted.current&&generation===requestGeneration.current)setError(describeOpsError(value));}).finally(()=>{if(mounted.current&&generation===requestGeneration.current)setBusy(false);});}}>查询核对真实客户</Button><Select aria-label="明确匹配客户和企业" style={{minWidth:340}} value={customerKey||undefined} placeholder="选 active 客户及其 active 企业" disabled={busy||unknown||Boolean(pending)} options={customers.map(row=>({value:`${row.customerId}:${row.workspaceId}`,label:`${row.name} · ${row.enterpriseName??row.workspaceId} · 账号 ${row.status} / 企业 ${row.workspaceStatus??"未核实"}`,disabled:row.status!=="active"||row.workspaceStatus!=="active"}))} onChange={setCustomerKey}/>
    <Button type="primary" disabled={!permissions.canMatchUnmatchedReceipts||!permissions.canSearchCustomers||!selected||!selectedCustomer||!reason.trim()||!evidence.trim()||busy||unknown||Boolean(pending)||selected.frozenReturnFen>0} onClick={event=>{if(!selected||!selectedCustomer)return;const input={workspace:selectedCustomer.workspaceId,receiptId:selected.id,customerRef:selectedCustomer.customerId,reason:reason.trim(),evidenceRef:evidence.trim()};request("确认原收款归属",`原流水 ${selected.externalTradeId}；原付款方 ${selected.payerRef}；实收 ${cashLabel(selected.amountFen)}；目标客户 ${selectedCustomer.name}；企业 ${selectedCustomer.enterpriseName??selectedCustomer.workspaceId}（${selectedCustomer.workspaceId}）。归属证据 ${input.evidenceRef}；只匹配，不自动支付或授予。`,confirmedReason=>controller.client.matchUnmatchedReceipt({...input,reason:confirmedReason}).then(value=>{if(value.id!==input.receiptId||value.workspaceId!==input.workspace)throw new Error("服务端匹配结果与确认企业或原收款不一致");return value;}),event.currentTarget,{key:intentKey("unmatched_match"),kind:"match",workspace:input.workspace,receiptId:input.receiptId,receivingAccountRef:selected.receivingAccountRef,externalTradeId:selected.externalTradeId,amountFen:selected.amountFen,payerRef:selected.payerRef});}}>预览匹配并核对归属</Button></Space>
    <Typography.Title level={5}>归属未知款返还原付款方</Typography.Title>
    <Alert type="warning" showIcon title="原款原付款方返还，独立审批" description="不猜企业归属，不授予权益；外部返款结果未知保持冻结，只登记真实外部流水。待处置返款未结束时不能匹配。"/>
    <Space wrap><Button disabled={!permissions.canReadUnmatchedReceipts||busy||Boolean(pending)&&!unknown} onClick={()=>void loadReturns()}>读取未匹配返款首页</Button><Button disabled={!permissions.canReadUnmatchedReceipts||!returnCursor||busy||Boolean(pending)&&!unknown} onClick={()=>{if(returnCursor)void loadReturns(returnCursor);}}>读取下一页未匹配返款</Button>
    <Button disabled={!permissions.canProposeReceiptReturn||!selected||amountFen===null||amountFen>selected.availableFen||!reason.trim()||!evidence.trim()||busy||unknown||Boolean(pending)} onClick={event=>{if(!selected||amountFen===null)return;const key=intentKey("unmatched_return");const input={receiptId:selected.id,returnId:key,amountFen,payerRef:selected.payerRef,expectedRevision:selected.revision,evidenceRef:evidence.trim(),reason:reason.trim()};request("申请未知归属款返还",`原流水 ${selected.externalTradeId}；返还 ${cashLabel(amountFen)} 给原付款方 ${selected.payerRef}；只申请，不代表已退款。`,confirmedReason=>controller.client.proposeUnmatchedReturn({...input,reason:confirmedReason}),event.currentTarget,{key,kind:"return",returnId:key,receiptId:selected.id,amountFen,payerRef:selected.payerRef,action:"propose"});}}>申请未知归属款返还</Button>
    <Select aria-label="选择未匹配原返款意图" style={{minWidth:320}} value={returnId||undefined} disabled={busy||unknown||Boolean(pending)} placeholder="已读取的原返款意图" options={returns.map(row=>({value:row.id,label:`${row.id} · ${cashLabel(row.amountFen)} · ${cashStateLabel(row.status)}`}))} onChange={setReturnId}/>
    {(["approve","reject"] as const).map(action=><Button key={action} disabled={!permissions.canApproveReceiptReturn||!selectedReturn||selectedReturn.status!=="requested"||!evidence.trim()||!reason.trim()||busy||unknown||Boolean(pending)} onClick={event=>{if(!selectedReturn)return;const key=intentKey(`unmatched_return_${action}`);request(action==="approve"?"独立审批未知归属返款":"拒绝未知归属返款",`原意图 ${selectedReturn.id}；${cashLabel(selectedReturn.amountFen)}；原付款方 ${selectedReturn.payerRef}；审批不代表外部返款完成。`,()=>controller.client.decideUnmatchedReturn({returnId:selectedReturn.id,action,evidenceRef:evidence.trim()}),event.currentTarget,{key,kind:"return",returnId:selectedReturn.id,receiptId:selectedReturn.receiptId,amountFen:selectedReturn.amountFen,payerRef:selectedReturn.payerRef,action});}}>{action==="approve"?"独立审批未知归属返款":"拒绝未知归属返款"}</Button>)}
    <Input aria-label="未匹配真实外部返款流水" placeholder="真实外部返款流水" value={externalReturnId} disabled={busy||unknown||Boolean(pending)} onChange={event=>setExternalReturnId(event.target.value)}/>
    {(["unknown","completed"] as const).map(outcome=><Button key={outcome} disabled={!permissions.canCompleteReceiptReturn||!selectedReturn||!["approved","pending_external","external_unknown"].includes(selectedReturn.status)||!evidence.trim()||!reason.trim()||outcome==="completed"&&!externalReturnId.trim()||busy||unknown||Boolean(pending)} onClick={event=>{if(!selectedReturn)return;const key=intentKey(`unmatched_return_${outcome}`);const external=outcome==="completed"?externalReturnId.trim():undefined;request(outcome==="unknown"?"登记未知归属返款结果未知":"核实未知归属返款完成",`原意图 ${selectedReturn.id}；${cashLabel(selectedReturn.amountFen)}；原付款方 ${selectedReturn.payerRef}；${external?`外部流水 ${external}`:"保持冻结，禁止另起返款"}；只登记结果，不发第二笔返款。`,()=>controller.client.completeUnmatchedReturn({returnId:selectedReturn.id,outcome,externalReturnId:external,evidenceRef:evidence.trim()}),event.currentTarget,{key,kind:"return",returnId:selectedReturn.id,receiptId:selectedReturn.receiptId,amountFen:selectedReturn.amountFen,payerRef:selectedReturn.payerRef,action:outcome,externalReturnId:external});}}>{outcome==="unknown"?"登记外部结果未知并冻结":"登记核实的未知归属返款完成"}</Button>)}</Space>
    {returns.length?<Table size="small" pagination={false} rowKey="id" dataSource={returns} columns={[{title:"原返款",dataIndex:"id"},{title:"原款",dataIndex:"receiptId"},{title:"原付款方",dataIndex:"payerRef"},{title:"返款金额",dataIndex:"amountFen",render:cashLabel},{title:"真实状态",dataIndex:"status",render:cashStateLabel},{title:"真实外部流水",dataIndex:"externalReturnId"}]}/>:null}
    {unknown?<Alert type="warning" showIcon title="原未匹配现金意图待核实" description={`保留原标识 ${recoveryKey}。只读查询并严格核对原事实；列表消失不证明匹配成功，null 或事实不一致不能解锁。`} action={<Button disabled={!permissions.canReadUnmatchedReceipts||busy} onClick={()=>void recover()}>查询原意图并核实结果</Button>}/>:null}
    <DangerActionModal open={Boolean(pending)&&!unknown} title={pending?.label??"确认待匹配收款"} objectLabel="核实摘要" objectValue={pending?.summary??""} scope="受限平台待匹配收款队列" impact="记录真实收款或原归属事实；不创建订单、钱包或商业授予。" reason={reason} onReasonChange={setReason} onConfirm={confirm} onCancel={()=>{if(!busy)setPending(undefined);}} loading={busy} error={error||undefined} initialFocus="cancel" triggerRef={triggerRef}/>
  </Space></section>;
}

export function CashReceiptOperationsPanel({ controller }: { controller: CommercialOperationsController }) {
  const workspace = controller.targetWorkspaceId;
  const allowed = controller.permissions.canReadOrders || controller.permissions.canRecordReceipt || controller.permissions.canAllocateReceipt || controller.permissions.canProposeReceiptReturn || controller.permissions.canApproveReceiptReturn || controller.permissions.canCompleteReceiptReturn;
  const [receipts, setReceipts] = useState<CommercialCashReceipt[]>([]);
  const [returns, setReturns] = useState<CommercialCashReturn[]>([]);
  const [receiptId, setReceiptId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [amount, setAmount] = useState("");
  const [receiver, setReceiver] = useState("");
  const [tradeId, setTradeId] = useState("");
  const [payer, setPayer] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [batch, setBatch] = useState<CashAllocationLine[]>([]);
  const [batchPreview, setBatchPreview] = useState<CashAllocationBatchPreview>();
  const [preview, setPreview] = useState<CommercialAllocationPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [recovery,setRecovery] = useState<CashRecoveryIntent>();
  const [fresh, setFresh] = useState(false);
  const [returnId, setReturnId] = useState("");
  const [externalReturnId, setExternalReturnId] = useState("");
  const [pending, setPending] = useState<{ key: string; label: string; summary: string; recovery?:CashRecoveryIntent; run: (confirmedReason: string) => Promise<unknown> }>();
  const triggerRef = useRef<HTMLElement | null>(null);
  const scopeGeneration = useRef(0);
  useEffect(() => { scopeGeneration.current++; setReceipts([]); setReturns([]); setBatch([]); setBatchPreview(undefined); setReceiptId(""); setOrderId(""); setPreview(undefined); setPending(undefined); setFresh(false); setUnknown(false); setError(""); setResult(""); setReturnId(""); setBusy(false); setRecoveryKey("");setRecovery(undefined);
    try { const saved = sessionStorage.getItem(`commercial-cash-intent:${workspace}`); if (saved) { const entry = JSON.parse(saved) as { key?: string; recovery?:CashRecoveryIntent }; if (typeof entry.key === "string") { setRecoveryKey(entry.key);setRecovery(entry.recovery); setUnknown(true); } } } catch { /* storage failure never enables a retry */ }
  }, [workspace]);
  const selected = fresh ? receipts.find(row => row.id === receiptId) : undefined;
  const orders = controller.data.orders.status === "ready" ? controller.data.orders.data?.items.filter(row => row.workspaceId === workspace) ?? [] : [];
  const selectedReturn = fresh ? returns.find(row => row.id === returnId) : undefined;
  let amountFen: number | null = null;
  try { amountFen = positiveCommercialFen(amount); } catch { /* malformed amount is a disabled write */ }
  const load = async () => {
    const generation = scopeGeneration.current;
    setBusy(true); setError(""); setFresh(false);
    try {
      const [nextReceipts, nextReturns] = await Promise.all([controller.client.listReceipts(workspace), controller.client.listReceiptReturns(workspace)]);
      if (generation !== scopeGeneration.current) return;
      setReceipts(nextReceipts); setReturns(nextReturns); setFresh(true);
      await controller.loadView("orders");
      if (unknown) setResult("已读取当前收款和订单事实；提交意图是否完成仍需按原标识核对，禁止重复付款或另建分配。");
    } catch (value) { if (generation === scopeGeneration.current) setError(describeOpsError(value)); }
    finally { if (generation === scopeGeneration.current) setBusy(false); }
  };
  const request = (label: string, summary: string, run: (confirmedReason: string) => Promise<unknown>, trigger: HTMLElement, businessKey: string) => { triggerRef.current = trigger; setError(""); let recovery:CashRecoveryIntent|undefined;
    if(businessKey.startsWith("cash_record" ) && amountFen!==null)recovery={key:businessKey,kind:"record",workspace,receivingAccountRef:receiver.trim(),externalTradeId:tradeId.trim(),amountFen,payerRef:payer.trim(),receivedAt:new Date(receivedAt).toISOString()};
    else if(businessKey.startsWith("cash_allocate") && preview)recovery={key:businessKey,kind:"allocation",workspace,batch:false,lines:[{receipt_id:preview.receipt.id,order_id:preview.orderId,amount_fen:preview.amountFen,expected_revision:preview.expectedRevision}]};
    else if(businessKey.startsWith("cash_batch"))recovery={key:businessKey,kind:"allocation",workspace,batch:true,lines:batch.map(row=>({...row}))};
    else if(businessKey.startsWith("cash_return")){const row=selectedReturn;const action=businessKey.startsWith("cash_return_approve")?"approve":businessKey.startsWith("cash_return_reject")?"reject":businessKey.startsWith("cash_return_unknown")?"unknown":businessKey.startsWith("cash_return_complete")?"completed":"propose";if(action==="propose" && selected && amountFen!==null)recovery={key:businessKey,kind:"return",workspace,returnId:businessKey,receiptId:selected.id,amountFen,payerRef:selected.payerRef,action};else if(row)recovery={key:businessKey,kind:"return",workspace,returnId:row.id,receiptId:row.receiptId,amountFen:row.amountFen,payerRef:row.payerRef,action,externalReturnId:action==="completed"?externalReturnId.trim():undefined};}
    setPending({ key: businessKey, label, summary, run,recovery }); };
  const confirm = async () => {
    if (!pending || !reason.trim() || busy || unknown) return;
    const generation = scopeGeneration.current;
    setBusy(true); setError(""); setRecoveryKey(pending.key);setRecovery(pending.recovery);
    try { sessionStorage.setItem(`commercial-cash-intent:${workspace}`, JSON.stringify({ key: pending.key, label: pending.label,recovery:pending.recovery })); } catch { /* the in-memory intent remains frozen */ }
    try {
      const value = await pending.run(reason.trim());
      if (generation !== scopeGeneration.current) return;
      if (value && typeof value === "object" && "id" in value && typeof value.id === "string") setReceiptId(value.id);
      try { sessionStorage.removeItem(`commercial-cash-intent:${workspace}`); } catch { /* stale marker fails closed on reload */ }
      setRecoveryKey(""); setPending(undefined); setPreview(undefined); setBatch([]); setBatchPreview(undefined); setUnknown(false); setResult("服务端已记录本次结果；订单、依赖及权益状态以刷新后的逐条事实为准。");
      await load();
    } catch (value) {
      if (generation !== scopeGeneration.current) return;
      const code = (value as { code?: string }).code;
      const status = (value as { httpStatus?: number }).httpStatus;
      const uncertain = !status || status >= 500 || ["API_NETWORK_ERROR", "API_REQUEST_TIMEOUT", "API_INVALID_RESPONSE"].includes(code ?? "");
      setUnknown(uncertain); setError(`${describeOpsError(value)}${uncertain ? " 提交结果待确认。保留原意图，先查询结果，禁止另建分配或重复返款。" : " 请刷新事实并重新预览。"}`);
      if (!uncertain) { try { sessionStorage.removeItem(`commercial-cash-intent:${workspace}`); } catch { /* fail closed */ } setRecoveryKey(""); setPending(undefined); setPreview(undefined); }
    } finally { if (generation === scopeGeneration.current) setBusy(false); }
  };
  const recover=async()=>{if(!recovery || recovery.workspace!==workspace){setError("原会话缺少当前企业的原始事实；请对账负责人核实原标识，不能另起意图。");return;}const generation=scopeGeneration.current;setBusy(true);setError("");try{if(!await recoverCashIntent(controller.client,recovery)){if(generation===scopeGeneration.current)setError("原意图未找到、批次部分缺失或事实不一致；仍保持锁定，不重复分配或返款。");return;}if(generation!==scopeGeneration.current)return;sessionStorage.removeItem(`commercial-cash-intent:${workspace}`);setUnknown(false);setPending(undefined);setRecovery(undefined);setRecoveryKey("");setPreview(undefined);setBatch([]);setBatchPreview(undefined);setResult("已核实原意图事实，没有再次执行付款/分配/返款；请刷新各项真实状态。");}catch(value){if(generation===scopeGeneration.current)setError(describeOpsError(value));}finally{if(generation===scopeGeneration.current)setBusy(false);}};
  if (!allowed) return null;
  return <section aria-label="指定企业收款与分配"><Space orientation="vertical" size="middle" className="full-width">
    <Typography.Title level={4}>真实收款、订单分配与余款处置</Typography.Title>
    <Alert type="info" showIcon title="收款事实与订单分别记录" description="核实真实人民币银行流水后登记；部分到账、等待开通依赖、未来待生效及待处置分别显示。收款截图不能自动开通，不要重复转账。" />
    {!workspace ? <Alert type="warning" showIcon title="请先选择目标企业 Workspace" description="只读取所选企业获授权的收款和订单；不会默认演示企业。" /> : <>
    <Space wrap><Typography.Text strong>企业：{workspace}</Typography.Text><Button disabled={busy || !controller.permissions.canReadOrders} onClick={() => void load()}>读取收款、订单与返款</Button></Space>
    {error ? <Alert role="alert" type="error" showIcon title={unknown ? "结果待确认" : "操作未完成"} description={error} /> : null}
    {result ? <Alert role="status" type="info" title={result} /> : null}
    <Typography.Title level={5}>1. 登记已核实的银行到账</Typography.Title>
    <Space wrap>
      <Input aria-label="核实收款账户引用" placeholder="核实收款账户引用" value={receiver} onChange={event => setReceiver(event.target.value)} disabled={busy || Boolean(pending)} />
      <Input aria-label="真实银行流水号" placeholder="真实银行流水号" value={tradeId} onChange={event => setTradeId(event.target.value)} disabled={busy || Boolean(pending)} />
      <Input aria-label="付款方" placeholder="付款方" value={payer} onChange={event => setPayer(event.target.value)} disabled={busy || Boolean(pending)} />
      <Input aria-label="实际到账金额（元）" placeholder="实际到账金额（元）" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setPreview(undefined); }} disabled={busy || Boolean(pending)} />
      <Input aria-label="真实到账时间" type="datetime-local" value={receivedAt} onChange={event => setReceivedAt(event.target.value)} disabled={busy || Boolean(pending)} />
      <Input aria-label="核实证据引用" placeholder="核实证据引用，不含密码或完整凭证" value={evidence} onChange={event => setEvidence(event.target.value)} disabled={busy || Boolean(pending)} />
      <Input aria-label="收款操作原因" placeholder="操作原因" value={reason} onChange={event => setReason(event.target.value)} disabled={busy || Boolean(pending)} />
      <Button disabled={!controller.permissions.canRecordReceipt || busy || unknown || Boolean(pending) || amountFen === null || !receiver.trim() || !tradeId.trim() || !payer.trim() || !evidence.trim() || !reason.trim() || !receivedAt || !Number.isFinite(new Date(receivedAt).valueOf()) || new Date(receivedAt).valueOf() > Date.now()} onClick={event => {
        if (amountFen === null) return;
        const key = intentKey("cash_record");
        const input = { workspace, source: "bank_transfer", receivingAccountRef: receiver.trim(), externalTradeId: tradeId.trim(), payerRef: payer.trim(), amountFen, receivedAt: new Date(receivedAt).toISOString(), evidenceRef: evidence.trim(), reason: reason.trim(), idempotencyKey: key };
        request("确认核实到账", `企业 ${workspace}；收款账户 ${input.receivingAccountRef}；付款方 ${input.payerRef}；银行流水 ${input.externalTradeId}；实收 ${cashLabel(input.amountFen)}；实际到账 ${time(input.receivedAt)}。此步骤只登记收款，不自动创建套餐或授予权益。`, confirmedReason => controller.client.recordReceipt({ ...input, reason: confirmedReason }), event.currentTarget, input.idempotencyKey);
      }}>预览到账事实</Button>
    </Space>
    <Typography.Title level={5}>2. 按原订单分配收款</Typography.Title><Input aria-label="本次分配或返还金额（元）" placeholder="本次分配或返还金额（元）" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setPreview(undefined); }} disabled={busy || Boolean(pending)} />
    <Space wrap>
      <Select aria-label="选择真实收款" style={{ minWidth: 300 }} placeholder="选择真实收款" value={receiptId || undefined} disabled={!fresh || busy || Boolean(pending)} options={receipts.map(row => ({ value: row.id, label: `${row.externalTradeId} · ${row.payerRef} · 可分配 ${cashLabel(row.availableFen)}` }))} onChange={value => { setReceiptId(value); setPreview(undefined); }} />
      <Select aria-label="选择原订单" style={{ minWidth: 300 }} placeholder="选择已读取的原订单" value={orderId || undefined} disabled={busy || Boolean(pending)} options={orders.map(row => ({ value: row.id, label: `${row.id} · ${row.amountLabel} · ${readableCommercialState(row.paymentState)}` }))} onChange={value => { setOrderId(value); setPreview(undefined); }} />
      <Button disabled={!controller.permissions.canAllocateReceipt || !selected || !orderId || amountFen === null || amountFen > selected.availableFen || busy || unknown || Boolean(pending)} loading={busy} onClick={() => {
        if (!selected || amountFen === null) return;
        const generation = scopeGeneration.current;
        setBusy(true); setError("");
        void controller.client.previewReceiptAllocation({ workspace, receiptId: selected.id, orderId, amountFen, expectedRevision: selected.revision }).then(value => { if (generation === scopeGeneration.current) setPreview(value); }).catch(value => { if (generation === scopeGeneration.current) setError(describeOpsError(value)); }).finally(() => { if (generation === scopeGeneration.current) setBusy(false); });
      }}>读取服务端分配预览</Button>
    </Space>
    {selected ? <Descriptions bordered size="small" column={4}><Descriptions.Item label="实收">{cashLabel(selected.amountFen)}</Descriptions.Item><Descriptions.Item label="已分配">{cashLabel(selected.allocatedFen)}</Descriptions.Item><Descriptions.Item label="已返/冻结">{cashLabel(selected.returnedFen)} / {cashLabel(selected.frozenReturnFen)}</Descriptions.Item><Descriptions.Item label="未分配可用">{cashLabel(selected.availableFen)}</Descriptions.Item></Descriptions> : null}
    {preview ? <>
      <Descriptions bordered size="small" column={2} aria-label="服务端收款分配摘要"><Descriptions.Item label="目标企业">{preview.workspaceId}</Descriptions.Item><Descriptions.Item label="原订单/商品">{preview.orderId} / {preview.skuCode}</Descriptions.Item><Descriptions.Item label="原订单金额">{cashLabel(preview.orderAmountFen)}</Descriptions.Item><Descriptions.Item label="本次分配">{cashLabel(preview.amountFen)}</Descriptions.Item><Descriptions.Item label="分配后可用余款">{cashLabel(preview.availableAfterFen)}</Descriptions.Item><Descriptions.Item label="授予判断">{cashStateLabel(preview.fulfillmentState)}</Descriptions.Item><Descriptions.Item label="确认截止">{time(preview.expiresAt)}</Descriptions.Item></Descriptions>
      <Button type="primary" disabled={!controller.permissions.canAllocateReceipt || busy || unknown || Boolean(pending) || !fresh || !reason.trim() || preview.workspaceId !== workspace || preview.receipt.id !== receiptId || preview.orderId !== orderId || preview.amountFen !== amountFen || Date.parse(preview.expiresAt) <= Date.now()} onClick={event => {
        const key = intentKey("cash_allocate");
        const input = { workspace, receiptId: preview.receipt.id, orderId: preview.orderId, amountFen: preview.amountFen, expectedRevision: preview.expectedRevision, previewHash: preview.previewHash, idempotencyKey: key, reason: reason.trim() };
        request("确认核验并分配", `企业 ${workspace}；流水 ${preview.receipt.externalTradeId}；付款方 ${preview.receipt.payerRef}；实际到账 ${time(preview.receipt.receivedAt)}；订单 ${preview.orderId}；本次 ${cashLabel(preview.amountFen)}；可用余款 ${cashLabel(preview.availableAfterFen)}；状态 ${cashStateLabel(preview.fulfillmentState)}。款项足额和依赖均满足后才授予，以逐项服务端事实为准。`, confirmedReason => controller.client.confirmReceiptAllocation({ ...input, reason: confirmedReason }), event.currentTarget, input.idempotencyKey);
      }}>确认核验 {cashLabel(preview.amountFen)}，分配以下明细</Button>
    </> : null}
    <Typography.Title level={5}>首购合款：开通费与首期订单联合分配</Typography.Title>
    <Alert type="info" showIcon title="联合分配全部明细" description="先选择真实收款、原订单和本次金额，再加入明细。开通费与首期必须是服务端联合建单的关联订单；整批确认成功后逐条核验依赖及授予状态。" />
    <Space wrap><Button disabled={!controller.permissions.canAllocateReceipt || !selected || !orderId || amountFen === null || busy || unknown || Boolean(pending) || batch.length >= 100 || batch.some(row => row.order_id === orderId)} onClick={() => { if (!selected || amountFen === null) return; const allocated = batch.filter(row => row.receipt_id === selected.id).reduce((sum,row) => sum + row.amount_fen,0); if (allocated + amountFen > selected.availableFen) { setError("本笔收款合计分配超过可用余款，请修改明细。"); return; } setBatch([...batch,{ receipt_id: selected.id, order_id: orderId, amount_fen: amountFen, expected_revision: selected.revision }]); setBatchPreview(undefined); }}>加入联合分配明细</Button><Button disabled={busy || unknown || Boolean(pending)} onClick={() => { setBatch([]); setBatchPreview(undefined); }}>清空未提交明细</Button><Button disabled={!controller.permissions.canAllocateReceipt || batch.length < 2 || busy || unknown || Boolean(pending)} onClick={() => { const generation = scopeGeneration.current; setBusy(true); setError(""); void controller.client.previewReceiptAllocationBatch(workspace,batch).then(value => { if (generation === scopeGeneration.current) setBatchPreview(value); }).catch(value => { if (generation === scopeGeneration.current) setError(describeOpsError(value)); }).finally(() => { if (generation === scopeGeneration.current) setBusy(false); }); }}>读取服务器联合分配预览</Button></Space>
    {batch.length ? <Table size="small" pagination={false} rowKey="order_id" dataSource={batch} columns={[{title:"原收款",dataIndex:"receipt_id"},{title:"原订单",dataIndex:"order_id"},{title:"本次分配",dataIndex:"amount_fen",render:cashLabel}]} /> : null}
    {batchPreview ? <><Descriptions bordered size="small" column={2}><Descriptions.Item label="整批分配总额">{cashLabel(batchPreview.items.reduce((sum,row) => sum + row.amountFen,0))}</Descriptions.Item><Descriptions.Item label="确认截止">{time(batchPreview.expiresAt)}</Descriptions.Item><Descriptions.Item label="订单逐条判断">{batchPreview.items.map(row => `${row.orderId}：${cashStateLabel(row.fulfillmentState)}`).join("；")}</Descriptions.Item></Descriptions><Button type="primary" disabled={!controller.permissions.canAllocateReceipt || busy || unknown || Boolean(pending) || !reason.trim() || Date.parse(batchPreview.expiresAt) <= Date.now() || batchPreview.items.some(row => row.workspaceId !== workspace)} onClick={event => { const input = { workspace, allocations: batch.map(row => ({...row})), previewHash: batchPreview.previewHash, idempotencyKey: intentKey("cash_batch") }; request("确认联合分配全部明细", batchPreview.items.map(row => `原流水 ${row.receipt.externalTradeId}，订单 ${row.orderId}，分配 ${cashLabel(row.amountFen)}`).join("；"), () => controller.client.confirmReceiptAllocationBatch(input), event.currentTarget,input.idempotencyKey); }}>确认核实并联合分配全部明细</Button></> : null}
    <Typography.Title level={5}>3. 未分配款返还原付款方</Typography.Title>
    <Alert type="warning" showIcon title="余款不自动变钱包，不抵扣新售价" description="返款需独立审批与真实外部返款凭证；外部结果未知保持冻结并查询原意图。已付订单退款按其来源政策处理，不能扣其他来源权益。" />
    <Space wrap>
      <Button disabled={!controller.permissions.canProposeReceiptReturn || !selected || amountFen === null || amountFen > selected.availableFen || !evidence.trim() || !reason.trim() || busy || unknown || Boolean(pending)} onClick={event => {
        if (!selected || amountFen === null) return;
        const key = intentKey("cash_return"); const input = { workspace, receiptId: selected.id, returnId: key, amountFen, payerRef: selected.payerRef, expectedRevision: selected.revision, evidenceRef: evidence.trim(), reason: reason.trim(), idempotencyKey: key };
        request("申请余款返还", `将 ${cashLabel(amountFen)} 返还原付款方 ${selected.payerRef}；企业 ${workspace}；流水 ${selected.externalTradeId}。此步骤只申请，不冒称已退款。`, confirmedReason => controller.client.proposeReceiptReturn({ ...input, reason: confirmedReason }), event.currentTarget, input.idempotencyKey);
      }}>申请返还本次金额</Button>
      <Select aria-label="选择原返款意图" style={{ minWidth: 300 }} value={returnId || undefined} placeholder="选择原返款意图" disabled={!fresh || busy || Boolean(pending)} options={returns.map(row => ({ value: row.id, label: `${row.id} · ${cashLabel(row.amountFen)} · ${cashStateLabel(row.status)}` }))} onChange={setReturnId} />
      <Button disabled={!controller.permissions.canApproveReceiptReturn || !selectedReturn || selectedReturn.status !== "requested" || !evidence.trim() || busy || unknown || Boolean(pending)} onClick={event => { if (!selectedReturn) return; const input = { workspace, returnId: selectedReturn.id, action: "approve" as const, evidenceRef: evidence.trim(), reason: reason.trim(), idempotencyKey: intentKey("cash_return_approve") }; request("审批并冻结返款金额", `${cashLabel(selectedReturn.amountFen)}；原付款方 ${selectedReturn.payerRef}；服务端要求独立审批者；批准不代表外部返款完成。`, confirmedReason => controller.client.decideReceiptReturn({ ...input, reason: confirmedReason }), event.currentTarget, input.idempotencyKey); }}>独立审批返款</Button>
      <Button disabled={!controller.permissions.canApproveReceiptReturn || !selectedReturn || selectedReturn.status !== "requested" || !evidence.trim() || busy || unknown || Boolean(pending)} onClick={event => { if (!selectedReturn) return; const input = { workspace, returnId: selectedReturn.id, action: "reject" as const, evidenceRef: evidence.trim(), reason: reason.trim(), idempotencyKey: intentKey("cash_return_reject") }; request("拒绝原返款申请", `原意图 ${selectedReturn.id}；金额 ${cashLabel(selectedReturn.amountFen)}；保留拒绝证据。`, confirmedReason => controller.client.decideReceiptReturn({ ...input,reason:confirmedReason }),event.currentTarget,input.idempotencyKey); }}>拒绝原返款申请</Button>
      <Button disabled={!controller.permissions.canCompleteReceiptReturn || !selectedReturn || !["approved", "pending_external", "external_unknown"].includes(selectedReturn.status) || !evidence.trim() || busy || unknown || Boolean(pending)} onClick={event => { if (!selectedReturn) return; const input = { workspace, returnId:selectedReturn.id, outcome:"unknown" as const,evidenceRef:evidence.trim(),reason:reason.trim(),idempotencyKey:intentKey("cash_return_unknown") }; request("登记外部返款结果未知", `原意图 ${selectedReturn.id}；保持 ${cashLabel(selectedReturn.amountFen)} 冻结；禁止另起返款。`,confirmedReason => controller.client.completeReceiptReturn({...input,reason:confirmedReason}),event.currentTarget,input.idempotencyKey); }}>登记外部结果未知，保持冻结</Button>
      <Input aria-label="真实外部返款流水" placeholder="真实外部返款流水" value={externalReturnId} onChange={event => setExternalReturnId(event.target.value)} disabled={busy || Boolean(pending)} />
      <Button disabled={!controller.permissions.canCompleteReceiptReturn || !selectedReturn || !["approved", "pending_external", "external_unknown"].includes(selectedReturn.status) || !externalReturnId.trim() || !evidence.trim() || busy || unknown || Boolean(pending)} onClick={event => { if (!selectedReturn) return; const input = { workspace, returnId: selectedReturn.id, outcome: "completed" as const, externalReturnId: externalReturnId.trim(), evidenceRef: evidence.trim(), reason: reason.trim(), idempotencyKey: intentKey("cash_return_complete") }; request("核实原意图返款完成", `原意图 ${selectedReturn.id}；返还 ${cashLabel(selectedReturn.amountFen)} 给 ${selectedReturn.payerRef}；真实外部流水 ${input.externalReturnId}。只登记已核实结果，不发送第二笔返款。`, confirmedReason => controller.client.completeReceiptReturn({ ...input, reason: confirmedReason }), event.currentTarget, input.idempotencyKey); }}>登记已核实返款结果</Button>
    </Space>
    {unknown ? <Alert type="warning" showIcon title="原提交结果待确认" description={`已保留原意图 ${recoveryKey}，不允许重新生成分配或返款。请查询原企业的收款、订单和返款事实并联系对账负责人。`} action={<Button disabled={busy} onClick={() => void recover()}>查询原意图并核实结果</Button>} /> : null}
    </>}
    <DangerActionModal open={Boolean(pending) && !unknown} title={pending?.label ?? "确认收款操作"} objectLabel="核实摘要" objectValue={pending?.summary ?? ""} scope={`workspace:${workspace}`} impact="以真实收款、订单快照及依赖校验提交；重复意图由服务端去重。" reason={reason} onReasonChange={setReason} onConfirm={confirm} onCancel={() => { if (!busy && !unknown) setPending(undefined); }} loading={busy} error={error || undefined} confirmLabel={unknown ? "先查询原结果，禁止重付" : "确认核实并记录"} initialFocus="cancel" triggerRef={triggerRef} />
  </Space></section>;
}

function PrivateTrialOperationsPanel({ controller }: { controller: CommercialOperationsController }) {
  const canOperate = controller.permissions.privateSkuReadable && controller.permissions.canGrantPrivateSku;
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
  const [outcome, setOutcome] = useState<CommercialOperationOutcome>(idleCommercialOperationOutcome);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<PendingCommercialOperation>();
  const [pendingReason, setPendingReason] = useState("");
  const [pendingError, setPendingError] = useState("");
  const confirmTriggerRef = useRef<HTMLElement | null>(null);
  if (!canOperate) return <Alert type="info" showIcon title="私测转正式仅对授权运营人员开放" description="需要 commercial.private_sku.grant 或 commercial.payment.reconcile；无权限时不会发起请求。" />;
  // Reversible preparation steps run on click; irreversible money/point commands
  // only reach the server through confirmPending() after an explicit confirmation.
  const run = async (id: CommercialOperationId, action: () => Promise<unknown>) => {
    if (!commercialOperationDecision(id, false).execute) return;
    setBusy(true); setOutcome(idleCommercialOperationOutcome);
    setOutcome(await settleCommercialOperation(action)); setBusy(false);
  };
  const requestConfirmation = (next: PendingCommercialOperation, trigger: HTMLElement | null) => {
    confirmTriggerRef.current = trigger;
    setPending(next); setPendingReason(next.defaultReason); setPendingError("");
  };
  const closeConfirmation = () => {
    if (busy) return;
    setPending(undefined); setPendingReason(""); setPendingError("");
  };
  const confirmPending = async () => {
    if (!pending || busy || !commercialOperationDecision(pending.id, true).execute) return;
    const target = pending;
    setBusy(true); setPendingError("");
    const result = await settleCommercialOperation(() => target.run(pendingReason));
    setBusy(false); setOutcome(result);
    if (result.status === "error") { setPendingError(result.text); return; }
    setPending(undefined);
  };
  const reason = "商业化方案：私测转正式人工核验";
  return <section aria-label="私测转正式与人工转账" className="commercial-manual-operations">
    <Typography.Title level={5}>私测转正式 / 人工转账开通</Typography.Title>
    <Alert type="warning" showIcon title="正式开通 5000 元；1999 元仅为 7 天试用，验证后 7 天内补 3001 元，必须人工核验到账证据后开通。" description="每一步都会写入商业时间线和审计；不要只改前端状态。" />
    <Space wrap>
      <Input aria-label="目标 Workspace" placeholder="目标 Workspace" value={workspace} onChange={event => setWorkspace(event.target.value)} />
      <Input aria-label="客户标识" placeholder="客户标识" value={customerRef} onChange={event => setCustomerRef(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !customerRef} onClick={() => void run("createPrivateTrialInvite", async () => controller.client.createPrivateTrialInvite(workspace, customerRef, new Date(Date.now() + 7 * 86400000).toISOString(), reason))}>生成私测邀请</Button>
      <Input aria-label="私测邀请编码" placeholder="私测邀请编码（生成后粘贴/保存）" value={inviteCode} onChange={event => setInviteCode(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !customerRef || !inviteCode} onClick={() => void run("createPrivateTrialEligibility", async () => { const value = await controller.client.createPrivateTrialEligibility(workspace, customerRef, inviteCode, reason); if (value && typeof value === "object") { const row = value as Record<string, unknown>; if (typeof row.eligibility_id === "string") setEligibilityId(row.eligibility_id); } return value; })}>使用邀请创建私测资格</Button>
      <Input aria-label="私测资格 ID" placeholder="私测资格 ID" value={eligibilityId} onChange={event => setEligibilityId(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !eligibilityId || !controller.permissions.canGrantPrivateSku} onClick={() => void run("approvePrivateTrialEligibility", () => controller.client.approvePrivateTrialEligibility(workspace, eligibilityId, revision, reason))}>业务审批</Button>
      <Button loading={busy} disabled={!workspace || !eligibilityId || !controller.permissions.canGrantPrivateSku} onClick={() => void run("createPrivateTrialOrder", async () => { const value = await controller.client.createPrivateTrialOrder(workspace, eligibilityId, "商业化方案：创建 1999 元私测订单"); if (value && typeof value === "object") { const row = value as Record<string, unknown>; const order = row.order; if (order && typeof order === "object" && typeof (order as Record<string, unknown>).order_id === "string") setTrialOrderId((order as Record<string, unknown>).order_id as string); } return value; })}>创建 1999 元私测订单</Button>
      <Button loading={busy} disabled={!workspace || !eligibilityId} onClick={() => void run("completePrivateTrialValidation", () => controller.client.completePrivateTrialValidation(workspace, eligibilityId, trialOrderId, new Date().toISOString(), reason))}>完成 7 天验证</Button>
      <Input aria-label="试用订单 ID" placeholder="试用订单 ID" value={trialOrderId} onChange={event => setTrialOrderId(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !eligibilityId || !controller.permissions.canGrantPrivateSku} onClick={() => void run("preparePrivateTrialCredit", async () => { const value = await controller.client.preparePrivateTrialCredit(workspace, eligibilityId, reason); if (value && typeof value === "object") { const row = value as Record<string, unknown>; if (typeof row.credit_id === "string") setCreditId(row.credit_id); } return value; })}>准备 3001 元抵扣</Button>
      <Input aria-label="抵扣 ID" placeholder="抵扣 ID" value={creditId} onChange={event => setCreditId(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !creditId || !controller.permissions.canGrantPrivateSku} onClick={() => void run("approvePrivateTrialCredit", () => controller.client.approvePrivateTrialCredit(workspace, creditId, reason))}>财务审批抵扣</Button>
      <Button loading={busy} disabled={!workspace || !creditId || !controller.permissions.canGrantPrivateSku} onClick={() => void run("createPrivateTrialConversionOrder", async () => { const value = await controller.client.createPrivateTrialConversionOrder(workspace, creditId, reason); if (value && typeof value === "object") { const row = value as Record<string, unknown>; if (typeof row.order_id === "string") setConversionOrderId(row.order_id); } return value; })}>创建正式订单</Button>
      <Input aria-label="正式订单 ID" placeholder="正式订单 ID" value={conversionOrderId} onChange={event => setConversionOrderId(event.target.value)} />
      <Input aria-label="支付主体引用" placeholder="支付主体引用" value={paymentSubjectRef} onChange={event => setPaymentSubjectRef(event.target.value)} />
      <Input aria-label="支付事件 ID" placeholder="支付事件 ID" value={providerEventId} onChange={event => setProviderEventId(event.target.value)} />
      <Input aria-label="支付订单 ID" placeholder="支付订单 ID" value={providerOrderId} onChange={event => setProviderOrderId(event.target.value)} />
      <Input aria-label="支付 nonce" placeholder="支付 nonce" value={nonce} onChange={event => setNonce(event.target.value)} />
      <Input aria-label="支付 payload hash" placeholder="支付 payload hash" value={payloadHash} onChange={event => setPayloadHash(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !trialOrderId || !paymentSubjectRef || !providerEventId || !providerOrderId || !nonce || !payloadHash || !controller.permissions.canReconcilePayment} onClick={event => requestConfirmation({
        id: "verifyPrivateTrialPayment",
        title: "核验 1999 元私测付款并授予权益",
        objectLabel: "试用订单 ID",
        objectValue: trialOrderId,
        scope: `workspace:${workspace}`,
        impact: "核验 1999 元到账后授予 7 天试用权益并写入商业时间线；核验结果不可撤销。",
        defaultReason: "商业化方案：核验 1999 元私测付款并授予试用权益",
        run: confirmedReason => controller.client.verifyPrivateTrialPayment(workspace, trialOrderId, paymentSubjectRef, providerEventId, providerOrderId, nonce, payloadHash, new Date().toISOString(), confirmedReason),
      }, event.currentTarget)}>核验 1999 元私测付款并授予权益</Button>
      <Button type="primary" loading={busy} disabled={!workspace || !creditId || !conversionOrderId || !paymentSubjectRef || !providerEventId || !providerOrderId || !nonce || !payloadHash || !controller.permissions.canReconcilePayment} onClick={event => requestConfirmation({
        id: "verifyPrivateTrialTransfer",
        title: "核验转账并开通",
        objectLabel: "抵扣 / 正式订单 ID",
        objectValue: `${dash(creditId)} / ${dash(conversionOrderId)}`,
        scope: `workspace:${workspace}`,
        impact: "核验 3001 元补款到账后开通正式权益并写入商业时间线；核验结果不可撤销。",
        defaultReason: reason,
        run: confirmedReason => controller.client.verifyPrivateTrialTransfer(workspace, creditId, conversionOrderId, paymentSubjectRef, providerEventId, providerOrderId, nonce, payloadHash, new Date().toISOString(), confirmedReason),
      }, event.currentTarget)}>核验转账并开通</Button>
      <Button loading={busy} disabled={!workspace || !conversionOrderId || !paymentSubjectRef || !providerEventId || !providerOrderId || !nonce || !payloadHash || !controller.permissions.canReconcilePayment} onClick={event => requestConfirmation({
        id: "verifyCommercialOrderTransfer",
        title: "核验商业订单转账",
        objectLabel: "商业订单 ID",
        objectValue: conversionOrderId,
        scope: `workspace:${workspace}`,
        impact: "核验该商业订单的真实到账证据并授予服务端已批准权益；核验结果不可撤销。",
        defaultReason: "商业化方案：核验商业订单人工转账",
        run: confirmedReason => controller.client.verifyCommercialOrderTransfer(workspace, conversionOrderId, paymentSubjectRef, providerEventId, providerOrderId, nonce, payloadHash, new Date().toISOString(), confirmedReason),
      }, event.currentTarget)}>核验商业订单转账</Button>
    </Space>
    <CommercialOperationOutcomeAlert outcome={outcome} />
    <DangerActionModal
      open={Boolean(pending)}
      title={pending?.title ?? "确认商业操作"}
      objectLabel={pending?.objectLabel ?? "对象"}
      objectValue={pending?.objectValue || "未填写"}
      scope={pending?.scope ?? "未指定"}
      impact={pending?.impact ?? "未指定"}
      reason={pendingReason}
      onReasonChange={setPendingReason}
      onConfirm={confirmPending}
      onCancel={closeConfirmation}
      loading={busy}
      error={pendingError || undefined}
      confirmLabel="确认执行并写入审计"
      initialFocus="cancel"
      triggerRef={confirmTriggerRef}
    />
  </section>;
}

export function matchingRefundEvent(
  page: CommercialPage<CommercialRefundEvent> | undefined,
  input: { workspace: string; orderId: string; requestId: string; amountFen: number; points: number; kind: CommercialRefundKind; expectedState: "requested" | "approved" },
): CommercialRefundEvent | null {
  if (!page || !input.workspace || !input.orderId || !input.requestId || !Number.isSafeInteger(input.amountFen) || !Number.isSafeInteger(input.points)) return null;
  const rows = page.items.filter(row => row.workspaceId === input.workspace && row.requestId === input.requestId);
  const latest = rows.reduce<CommercialRefundEvent | null>((current, row) => !current || row.revision > current.revision ? row : current, null);
  if (!latest || rows.filter(row => row.revision === latest.revision).length !== 1) return null;
  if (latest.eventType !== input.expectedState || latest.orderId !== input.orderId || latest.amountFen !== input.amountFen || latest.pointsToRevoke !== input.points || latest.refundKind !== input.kind) return null;
  return latest;
}

export function CommercialRefundOperationsPanel({ controller }: { controller: CommercialOperationsController }) {
  const [workspace, setWorkspace] = useState(controller.targetWorkspaceId);
  const [orderId, setOrderId] = useState("");
  const [requestId, setRequestId] = useState("");
  const [amountYuan, setAmountYuan] = useState("");
  const [points, setPoints] = useState("0");
  const [refundKind, setRefundKind] = useState<CommercialRefundKind>("monthly_unused_points");
  const [requestEvidenceRef, setRequestEvidenceRef] = useState("");
  const [externalRefundId, setExternalRefundId] = useState("");
  const [policyApproval, setPolicyApproval] = useState('{"legal_review_ref":""}');
  const [outcome, setOutcome] = useState<CommercialOperationOutcome>(idleCommercialOperationOutcome);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingCommercialOperation>();
  const [pendingReason, setPendingReason] = useState("");
  const [pendingError, setPendingError] = useState("");
  const confirmTriggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setWorkspace(controller.targetWorkspaceId);
    setOrderId(""); setRequestId(""); setAmountYuan(""); setPoints("0");
  }, [controller.targetWorkspaceId]);
  let policyApprovalReady = false;
  try { refundPolicyApproval(policyApproval); policyApprovalReady = true; } catch { /* invalid evidence stays disabled */ }
  if (!controller.permissions.canReconcilePayment) return null;
  // Applications and approvals stay reversible; only the final completion that
  // registers the external refund and rolls points back needs a confirmation.
  const run = async (id: CommercialOperationId, action: () => Promise<unknown>) => {
    if (!commercialOperationDecision(id, false).execute) return;
    setBusy(true); setOutcome(idleCommercialOperationOutcome);
    const result = await settleCommercialOperation(action);
    setOutcome(result); setBusy(false);
    if (result.status === "success") refreshRefunds();
  };
  const requestConfirmation = (next: PendingCommercialOperation, trigger: HTMLElement | null) => {
    confirmTriggerRef.current = trigger;
    setPending(next); setPendingReason(next.defaultReason); setPendingError("");
  };
  const closeConfirmation = () => {
    if (busy) return;
    setPending(undefined); setPendingReason(""); setPendingError("");
  };
  const confirmPending = async () => {
    if (!pending || busy || !commercialOperationDecision(pending.id, true).execute) return;
    const target = pending;
    setBusy(true); setPendingError("");
    const result = await settleCommercialOperation(() => target.run(pendingReason));
    setBusy(false); setOutcome(result);
    if (result.status === "error") { setPendingError(result.text); return; }
    refreshRefunds();
    setPending(undefined);
  };
  const reason = "商业化方案：订单退款人工审核";
  const refundState = controller.refunds;
  const refundItems = refundState.data?.items ?? [];
  const refreshRefunds = () => void controller.loadRefunds();
  const refundInput = (expectedState: "requested" | "approved") => ({
    workspace, orderId, requestId,
    amountFen: /^\d+(?:\.\d{1,2})?$/u.test(amountYuan) ? yuanToFen(amountYuan) : NaN,
    points: /^\d+$/u.test(points) ? Number(points) : NaN,
    kind: refundKind, expectedState,
  });
  const loadedRefund = (expectedState: "requested" | "approved") => refundState.status === "ready" && workspace === controller.targetWorkspaceId
    ? matchingRefundEvent(refundState.data, refundInput(expectedState)) : null;
  const requestedRefund = loadedRefund("requested");
  const approvedRefund = loadedRefund("approved");
  const requireFreshRefund = async (expectedState: "requested" | "approved") => {
    if (workspace !== controller.targetWorkspaceId) throw new Error("退款 Workspace 与当前读取范围不一致，请刷新后重试");
    const latest = await controller.loadRefunds();
    const matched = matchingRefundEvent(latest ?? undefined, refundInput(expectedState));
    if (!matched) throw new Error("服务端退款记录或状态已变化，请刷新记录并重新选择");
    return matched;
  };
  const selectRefund = (row: CommercialRefundEvent) => {
    setWorkspace(row.workspaceId); setOrderId(row.orderId); setRequestId(row.requestId);
    setAmountYuan((row.amountFen / 100).toFixed(2)); setPoints(String(row.pointsToRevoke)); setRefundKind(row.refundKind);
  };
  const refundKindLabel = (kind: CommercialRefundKind) => ({ onboarding_pre_deployment: "部署前实施费", monthly_unused_points: "月费未使用点数", point_pack_unused_points: "点数包未使用点数", outage_compensation: "故障补偿", custom_milestone: "定制里程碑" }[kind]);
  const refundEventLabel = (eventType: string) => ({ requested: "已申请", approved: "已审批", rejected: "已拒绝", completed: "已完成", reconciliation_required: "待对账" }[eventType] ?? eventType);
  const refundList = !controller.targetWorkspaceId ? <Alert type="info" showIcon title="请先指定目标企业主体 Workspace" description="选择范围后才会读取服务端退款记录。" />
    : refundState.status === "forbidden" ? <Alert type="info" showIcon title="退款记录不可读" description="当前会话没有 commercial.payment.reconcile；不会发起退款记录请求。" />
    : refundState.status === "error" ? <Alert type="error" showIcon title="退款记录读取失败" description={refundState.error?.message ?? "服务端未返回退款记录"} action={<Button onClick={refreshRefunds}>重试</Button>} />
      : refundState.status === "loading" && !refundState.data ? <Skeleton active paragraph={{ rows: 3 }} />
        : <>
          <Space><Typography.Text strong>服务端退款请求与状态</Typography.Text><Typography.Text type="secondary">{refundItems.length} 条事件（同一请求的申请、审批、完成均保留）</Typography.Text><Button size="small" icon={<ReloadOutlined />} onClick={refreshRefunds}>刷新记录</Button></Space>
          <Table<CommercialRefundEvent> rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={refundItems} locale={{ emptyText: "服务端未返回退款记录" }} scroll={{ x: 1420 }} columns={[
            { title: "事件时间", dataIndex: "createdAt", width: 180, render: time },
            { title: "状态", dataIndex: "eventType", width: 120, render: (value: string) => <StateTag value={refundEventLabel(value)} semanticValue={value} /> },
            { title: "退款请求", dataIndex: "requestId", width: 220, render: (value: string) => <Typography.Text code copyable>{value}</Typography.Text> },
            { title: "订单", dataIndex: "orderId", width: 210, render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
            { title: "类型", dataIndex: "refundKind", width: 150, render: (value: CommercialRefundKind) => refundKindLabel(value) },
            { title: "金额", dataIndex: "amountFen", width: 110, align: "right", render: (value: number) => `¥${(value / 100).toFixed(2)}` },
            { title: "回滚点数", dataIndex: "pointsToRevoke", width: 100, align: "right", render: point },
            { title: "操作者", dataIndex: "actorId", width: 150, render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
            { title: "外部退款凭证", dataIndex: "externalRefundId", width: 210, render: dash },
            { title: "操作", width: 100, render: (_, row) => <Button size="small" onClick={() => selectRefund(row)}>选择记录</Button> },
          ]} />
        </>;
  return <section aria-label="商业订单退款" className="commercial-manual-operations">
    <Typography.Title level={5}>商业订单退款 / 点数回滚</Typography.Title>
    <Alert type="warning" showIcon title="退款必须经过双人审批、法律/补充协议证据和外部支付退款凭证；不会因为前端点击直接退款。" />
    <Space orientation="vertical" size="middle" className="full-width">
    {refundList}
    <Space wrap>
      <Input aria-label="退款目标 Workspace" placeholder="目标 Workspace" value={workspace} onChange={event => setWorkspace(event.target.value)} />
      <Input aria-label="退款订单 ID" placeholder="订单 ID" value={orderId} onChange={event => setOrderId(event.target.value)} />
      <Input aria-label="退款请求 ID" placeholder="退款请求 ID（幂等）" value={requestId} onChange={event => setRequestId(event.target.value)} />
      <Input aria-label="退款金额（元）" placeholder="退款金额（元，保留两位小数）" value={amountYuan} onChange={event => setAmountYuan(event.target.value)} inputMode="decimal" />
      <Input aria-label="回滚创意点" placeholder="回滚创意点，默认 0" value={points} onChange={event => setPoints(event.target.value)} />
      <Select aria-label="退款类型" value={refundKind} onChange={value => setRefundKind(value)} options={[
        { value: "onboarding_pre_deployment", label: "部署前实施费" }, { value: "monthly_unused_points", label: "月费未使用点数" }, { value: "point_pack_unused_points", label: "点数包未使用点数" }, { value: "outage_compensation", label: "故障补偿" }, { value: "custom_milestone", label: "定制里程碑" },
      ]} />
      <Input aria-label="退款申请证据引用" placeholder={refundKind === "monthly_unused_points" ? "补充协议编号" : refundKind === "point_pack_unused_points" ? "到期政策编号" : refundKind === "outage_compensation" ? "事故 ID" : refundKind === "custom_milestone" ? "里程碑 ID" : "部署前自动记录 not_started"} value={requestEvidenceRef} disabled={refundKind === "onboarding_pre_deployment"} onChange={event => setRequestEvidenceRef(event.target.value)} />
      <Button loading={busy} disabled={!workspace || !orderId || !requestId || !amountYuan || (refundKind !== "onboarding_pre_deployment" && !requestEvidenceRef.trim())} onClick={() => void run("requestCommercialRefund", () => controller.client.requestCommercialRefund({ workspace, orderId, requestId, kind: refundKind, amountFen: yuanToFen(amountYuan), pointsToRevoke: Number(points || "0"), reason, evidenceRef: requestEvidenceRef }))}>提交退款申请</Button>
      <Input aria-label="政策审批证据 JSON" placeholder="政策审批证据 JSON" value={policyApproval} onChange={event => setPolicyApproval(event.target.value)} />
      <Button loading={busy} disabled={!requestedRefund || !policyApprovalReady || busy} onClick={() => void run("approveCommercialRefund", async () => { await requireFreshRefund("requested"); return controller.client.approveCommercialRefund(workspace, requestId, policyApproval, reason); })}>双人审批</Button>
      <Input aria-label="外部退款凭证" placeholder="外部退款凭证 / 转账流水号" value={externalRefundId} onChange={event => setExternalRefundId(event.target.value)} />
      <Button type="primary" loading={busy} disabled={!approvedRefund || !externalRefundId || busy} onClick={event => requestConfirmation({
        id: "completeCommercialRefund",
        title: "登记退款并回滚点数",
        objectLabel: "退款请求 ID",
        objectValue: requestId,
        scope: `workspace:${workspace} · 订单 ${dash(orderId)} · 退款 ${dash(amountYuan)} 元 · 外部凭证 ${dash(externalRefundId)}`,
        impact: `登记后该项退款被视为已完成，并回滚 ${dash(points || "0")} 创意点；不可撤销。`,
        defaultReason: reason,
        run: async confirmedReason => { await requireFreshRefund("approved"); return controller.client.completeCommercialRefund(workspace, requestId, externalRefundId, JSON.stringify({ source: "ops_console", action: "external_refund_verified" }), confirmedReason); },
      }, event.currentTarget)}>登记退款并回滚点数</Button>
    </Space>
    </Space>
    <CommercialOperationOutcomeAlert outcome={outcome} />
    <DangerActionModal
      open={Boolean(pending)}
      title={pending?.title ?? "确认商业操作"}
      objectLabel={pending?.objectLabel ?? "对象"}
      objectValue={pending?.objectValue || "未填写"}
      scope={pending?.scope ?? "未指定"}
      impact={pending?.impact ?? "未指定"}
      reason={pendingReason}
      onReasonChange={setPendingReason}
      onConfirm={confirmPending}
      onCancel={closeConfirmation}
      loading={busy}
      error={pendingError || undefined}
      confirmLabel="确认登记并回滚点数"
      initialFocus="cancel"
      triggerRef={confirmTriggerRef}
    />
  </section>;
}

export function CommercialOperationsWorkspace({ controller, catalogGovernanceHref = platformCatalogGovernanceTarget.href }: { controller: CommercialOperationsController; catalogGovernanceHref?: string }) {
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { viewHeadingRef.current?.focus({ preventScroll: true }); }, [controller.view]);
  return (
    <Space orientation="vertical" size="middle" className="full-width commercial-operations-workspace">
      <CommercialAccessStatusBar state={controller.summary} onRetry={() => void controller.loadSummary()} />
      <AssistedPurchaseOperationsPanel controller={controller} />
      <UnmatchedCashOperationsPanel controller={controller} />
      <CashReceiptOperationsPanel controller={controller} />
      <details><summary>历史私测协议操作</summary><PrivateTrialOperationsPanel controller={controller} /></details>
      <CommercialRefundOperationsPanel controller={controller} />
      <PointAdjustmentPanel controller={controller} />
      <ServiceFulfillmentPanel controller={controller} />
      <Alert
        type="info"
        showIcon
        title="套餐、订单和权益是三类不同记录"
        description="套餐目录定义卖什么；订单记录谁买了什么以及支付是否核验；权益快照记录实际授予哪个企业工作区、有效多久和还剩多少。支付成功不等于权益已到账。"
      />
      <Tabs activeKey={controller.view} onChange={key => controller.setView(key as CommercialView)} items={commercialViews.map(view => ({ key: view, label: commercialViewLabels[view] }))} />
      <section className="commercial-view" aria-labelledby={`commercial-view-${controller.view}`}>
        <Typography.Title ref={viewHeadingRef} tabIndex={-1} id={`commercial-view-${controller.view}`} level={4}>{commercialViewLabels[controller.view]}</Typography.Title>
        {renderView(controller.view, controller, catalogGovernanceHref)}
      </section>
    </Space>
  );
}
