import { rpc } from "./opsClient.js";

export const commercialOperationsMethods = {
  accessSummary: "ops.commercial.access.summary",
  accessBlocks: "ops.commercial.access-blocks.list",
  entitlements: "ops.commercial.entitlements.list",
  ledger: "ops.commercial.points-ledger.list",
  catalog: "ops.commercial.catalog-v2.list",
  orders: "ops.commercial.orders-v2.list",
  rates: "ops.commercial.rate-cards.list",
  services: "ops.commercial.service-fulfillment.list",
  timeline: "ops.commercial.timeline.list",
  readiness: "ops.commercial.readiness.report",
  privateTrialEligibilityCreate: "ops.commercial.private-trial.eligibility.create",
  privateTrialEligibilityApprove: "ops.commercial.private-trial.eligibility.approve",
  privateTrialValidationComplete: "ops.commercial.private-trial.validation.complete",
  privateTrialCreditPrepare: "ops.commercial.private-trial.credit.prepare",
  privateTrialCreditApprove: "ops.commercial.private-trial.credit.approve",
  privateTrialConversionCreate: "ops.commercial.private-trial.conversion.create",
  privateTrialPaymentVerify: "ops.commercial.private-trial.payment.verify",
  orderPaymentVerify: "ops.commercial.order.payment.verify",
  refundList: "ops.commercial.order.refund.list",
  refundRequest: "ops.commercial.order.refund.request",
  refundApprove: "ops.commercial.order.refund.approve",
  refundComplete: "ops.commercial.order.refund.complete",
} as const;

export type CommercialRefundKind = "onboarding_pre_deployment" | "monthly_unused_points" | "point_pack_unused_points" | "outage_compensation" | "custom_milestone";

export function commercialRefundEvidence(kind: CommercialRefundKind, evidenceRef: string): Record<string, string> {
  const reference = evidenceRef.trim();
  if (kind === "onboarding_pre_deployment") return { deployment_status: "not_started" };
  if (!reference) throw new Error("退款类型对应的政策或业务证据引用不能为空");
  const key = kind === "monthly_unused_points" ? "supplement_agreement_ref"
    : kind === "point_pack_unused_points" ? "expiry_policy_ref"
      : kind === "outage_compensation" ? "incident_id" : "milestone_id";
  return { [key]: reference };
}

export function refundPolicyApproval(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("政策审批证据必须是 JSON 对象"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).legal_review_ref !== "string" || !(parsed as Record<string, string>).legal_review_ref.trim()) throw new Error("政策审批证据必须包含非空 legal_review_ref");
  return parsed as Record<string, unknown>;
}

const operationId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const serviceCommand = async (method: string, targetWorkspaceId: string, allocationId: string, expectedRevision: number, reason: string, extra: Record<string, string> = {}) => rpc(method, { target_workspace_id: targetWorkspaceId, allocation_id: allocationId, expected_revision: String(expectedRevision), idempotency_key: operationId("service_fulfillment"), reason, evidence_json: JSON.stringify({ source: "ops_console", mode: "test" }), ...extra });
const createServiceAllocation = async (input: { workspace: string; order: string; entitlement: string; serviceType: string; unit: string; quantity: number; checksum: string; reason: string }) => rpc("ops.commercial.service-allocation.create", { target_workspace_id: input.workspace, order_snapshot_id: input.order, entitlement_snapshot_id: input.entitlement, service_type: input.serviceType, unit: input.unit, allocated_quantity: String(input.quantity), source_checksum: input.checksum, expected_revision: "0", idempotency_key: operationId("service_allocation_create"), reason: input.reason, evidence_json: JSON.stringify({ source: "ops_console", mode: "test" }) });

export const commercialCapabilities = {
  accessRead: "commercial.access.read",
  accessRecover: "commercial.access.recover",
  entitlementRead: "commercial.entitlement.read",
  pointRead: "commercial.point.read",
  pointAdjust: "commercial.point.adjust",
  catalogRead: "commercial.catalog.read",
  catalogDraft: "commercial.catalog.draft",
  catalogPublish: "commercial.catalog.publish",
  privateSkuRead: "commercial.private_sku.read",
  privateSkuGrant: "commercial.private_sku.grant",
  orderRead: "commercial.order.read",
  paymentReconcile: "commercial.payment.reconcile",
  rateRead: "commercial.rate.read",
  rateDraft: "commercial.rate.draft",
  rateApprove: "commercial.rate.approve",
  serviceRead: "commercial.service_fulfillment.read",
  serviceWrite: "commercial.service_fulfillment.write",
} as const;

type RecordValue = Record<string, unknown>;

const object = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const optionalText = (value: unknown): string | null => text(value) ? value : null;
const finiteNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const boolean = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter(text) : [];
const pick = (row: RecordValue, ...keys: string[]): unknown => keys.map((key) => row[key]).find((value) => value !== undefined);

function invalid(method: string, detail: string): never {
  throw new Error(`${method} 返回无法识别的商业运营数据：${detail}`);
}

function requiredText(row: RecordValue, method: string, label: string, ...keys: string[]): string {
  const value = pick(row, ...keys);
  return text(value) ? value : invalid(method, `${label} 缺失`);
}

function pageRows(value: unknown, method: string): { rows: RecordValue[]; total: number } {
  const rows = Array.isArray(value) ? value : object(value) && Array.isArray(value.items) ? value.items : null;
  if (!rows || !rows.every(object)) invalid(method, "items 必须是对象数组");
  const rawTotal = object(value) ? finiteNumber(value.total) : null;
  return { rows, total: rawTotal ?? rows.length };
}

export interface CommercialAccessSummary {
  decisionId: string;
  workspaceId: string;
  balanceState: string;
  availablePoints: number | null;
  reservedPoints: number | null;
  quotedPoints: number | null;
  accessRevision: string | null;
  rateCardVersion: string | null;
  catalogVersion: string | null;
  errorCode: string | null;
  allowed: boolean;
  earliestExpiresAt: string | null;
  verifiedAt: string | null;
  nextActions: string[];
}

export interface CommercialAccessBlock {
  id: string;
  workspaceId: string;
  state: string;
  errorCode: string;
  availablePoints: number | null;
  quotedPoints: number | null;
  accessRevision: string | null;
  occurredAt: string | null;
  verifiedAt: string | null;
  paymentState: string | null;
  grantState: string | null;
  requestId: string | null;
  nextActions: string[];
}

export interface CommercialEntitlement {
  id: string;
  workspaceId: string;
  skuCode: string;
  snapshotVersion: string;
  status: string;
  brandLimit: number | null;
  storeLimit: number | null;
  storageLabel: string | null;
  serviceSummary: string | null;
  periodLabel: string | null;
  sourceOrderId: string | null;
  updatedAt: string | null;
}

export interface CreativePointLedgerEntry {
  id: string;
  workspaceId: string;
  eventType: string;
  pointsDelta: number;
  balanceAfter: number | null;
  source: string;
  periodLabel: string | null;
  expiresAt: string | null;
  operationId: string | null;
  actorId: string | null;
  idempotencyKey: string | null;
  status: string;
  occurredAt: string;
  evidence: RecordValue;
}

export interface CommercialCatalogItem {
  id: string;
  skuCode: string;
  name: string;
  type: string;
  visibility: string;
  version: string;
  priceLabel: string;
  cycleLabel: string | null;
  benefitsSummary: string;
  approvalState: string;
  validFrom: string | null;
  validTo: string | null;
  unresolved: string[];
}

export interface CommercialOrderItem {
  id: string;
  workspaceId: string;
  skuCode: string;
  skuVersion: string;
  purchasedPoints: number | null;
  amountLabel: string;
  channel: string | null;
  paymentState: string;
  grantState: string;
  accessRevision: string | null;
  createdAt: string;
  paidAt: string | null;
  requestId: string | null;
}

export interface CreativePointRateItem {
  id: string;
  actionCode: string;
  actionLabel: string;
  unitLabel: string;
  pointsRule: string;
  version: string;
  approvalState: string;
  validFrom: string | null;
  validTo: string | null;
  blockingReason: string | null;
}

export interface ServiceFulfillmentItem {
  id: string;
  workspaceId: string;
  serviceType: string;
  allocationLabel: string;
  usedLabel: string;
  scheduleAt: string | null;
  status: string;
  ownerLabel: string | null;
  evidenceLabel: string | null;
  updatedAt: string | null;
}

export interface CommercialTimelineEvent {
  id: string;
  workspaceId: string;
  kind: string;
  status: string;
  occurredAt: string;
  operationId: string | null;
  traceId: string | null;
  requestId: string | null;
  actorId: string | null;
  reason: string | null;
  resourceId: string | null;
  evidence: RecordValue;
}

export interface CommercialReadinessBlocker {
  code: string;
  severity: string;
  scope: string;
  detail: string;
  nextAction: string;
}

export interface CommercialReadinessReport {
  ready: boolean;
  environment: string;
  message: string;
  generatedAt: string | null;
  blockers: CommercialReadinessBlocker[];
  capabilities: RecordValue;
  catalog: RecordValue;
  policies: RecordValue;
  registry: Array<{ operation: string; enabled: boolean }>;
  provider: RecordValue;
  creativePoints: RecordValue;
}

export interface CommercialPage<T> { items: T[]; total: number }

export function parseCommercialAccessSummary(value: unknown): CommercialAccessSummary {
  const method = commercialOperationsMethods.accessSummary;
  if (!object(value)) invalid(method, "结果必须是对象");
  const allowed = boolean(value.allowed);
  if (allowed === null) invalid(method, "allowed 缺失");
  const balanceState = requiredText(value, method, "balance_state", "balance_state", "balanceState");
  const availablePoints = finiteNumber(pick(value, "available_points", "availablePoints"));
  const reservedPoints = finiteNumber(pick(value, "reserved_points", "reservedPoints"));
  if (balanceState === "known" && (availablePoints === null || reservedPoints === null)) invalid(method, "known 余额必须包含 available_points 与 reserved_points");
  if (balanceState === "unknown" && (availablePoints !== null || reservedPoints !== null)) invalid(method, "unknown 余额不能携带确定点数");
  return {
    decisionId: requiredText(value, method, "decision_id", "decision_id", "decisionId"),
    workspaceId: requiredText(value, method, "workspace_id", "workspace_id", "workspaceId"),
    balanceState,
    availablePoints,
    reservedPoints,
    quotedPoints: finiteNumber(pick(value, "quoted_points", "quotedPoints")),
    accessRevision: optionalText(pick(value, "access_revision", "accessRevision")),
    rateCardVersion: optionalText(pick(value, "rate_card_version", "rateCardVersion")),
    catalogVersion: optionalText(pick(value, "catalog_version", "catalogVersion")),
    errorCode: optionalText(pick(value, "error_code", "errorCode")),
    allowed,
    earliestExpiresAt: optionalText(pick(value, "earliest_expires_at", "earliestExpiresAt")),
    verifiedAt: optionalText(pick(value, "verified_at", "verifiedAt", "decided_at", "decidedAt")),
    nextActions: stringArray(pick(value, "next_actions", "nextActions")),
  };
}

export function parseAccessBlocks(value: unknown): CommercialPage<CommercialAccessBlock> {
  const method = commercialOperationsMethods.accessBlocks;
  const page = pageRows(value, method);
  return { total: page.total, items: page.rows.map((row) => ({
    id: requiredText(row, method, "id", "id", "decision_id"),
    workspaceId: requiredText(row, method, "workspace_id", "workspace_id", "workspaceId"),
    state: requiredText(row, method, "state", "state", "status"),
    errorCode: requiredText(row, method, "error_code", "error_code", "errorCode"),
    availablePoints: finiteNumber(pick(row, "available_points", "availablePoints")),
    quotedPoints: finiteNumber(pick(row, "quoted_points", "quotedPoints")),
    accessRevision: optionalText(pick(row, "access_revision", "accessRevision")),
    occurredAt: optionalText(pick(row, "occurred_at", "occurredAt", "created_at", "createdAt")),
    verifiedAt: optionalText(pick(row, "verified_at", "verifiedAt")),
    paymentState: optionalText(pick(row, "payment_state", "paymentState")),
    grantState: optionalText(pick(row, "grant_state", "grantState")),
    requestId: optionalText(pick(row, "request_id", "requestId")),
    nextActions: stringArray(pick(row, "next_actions", "nextActions")),
  })) };
}

export function parseEntitlements(value: unknown): CommercialPage<CommercialEntitlement> {
  const method = commercialOperationsMethods.entitlements;
  const page = pageRows(value, method);
  return { total: page.total, items: page.rows.map((row) => ({
    id: requiredText(row, method, "id", "id", "snapshot_id"),
    workspaceId: requiredText(row, method, "workspace_id", "workspace_id", "workspaceId"),
    skuCode: requiredText(row, method, "sku_code", "sku_code", "skuCode"),
    snapshotVersion: requiredText(row, method, "snapshot_version", "snapshot_version", "snapshotVersion", "version"),
    status: requiredText(row, method, "status", "status"),
    brandLimit: finiteNumber(pick(row, "brand_limit", "brandLimit")),
    storeLimit: finiteNumber(pick(row, "store_limit", "storeLimit")),
    storageLabel: optionalText(pick(row, "storage_label", "storageLabel")),
    serviceSummary: optionalText(pick(row, "service_summary", "serviceSummary")),
    periodLabel: optionalText(pick(row, "period_label", "periodLabel")),
    sourceOrderId: optionalText(pick(row, "source_order_id", "sourceOrderId")),
    updatedAt: optionalText(pick(row, "updated_at", "updatedAt")),
  })) };
}

export function parseLedger(value: unknown): CommercialPage<CreativePointLedgerEntry> {
  const method = commercialOperationsMethods.ledger;
  const page = pageRows(value, method);
  return { total: page.total, items: page.rows.map((row) => {
    const pointsDelta = finiteNumber(pick(row, "points_delta", "pointsDelta"));
    if (pointsDelta === null) invalid(method, "points_delta 缺失");
    return {
      id: requiredText(row, method, "id", "id"), workspaceId: requiredText(row, method, "workspace_id", "workspace_id", "workspaceId"),
      eventType: requiredText(row, method, "event_type", "event_type", "eventType"), pointsDelta,
      balanceAfter: finiteNumber(pick(row, "balance_after", "balanceAfter")), source: requiredText(row, method, "source", "source"),
      periodLabel: optionalText(pick(row, "period_label", "periodLabel")), expiresAt: optionalText(pick(row, "expires_at", "expiresAt")),
      operationId: optionalText(pick(row, "operation_id", "operationId")), actorId: optionalText(pick(row, "actor_id", "actorId")),
      idempotencyKey: optionalText(pick(row, "idempotency_key", "idempotencyKey")), status: requiredText(row, method, "status", "status"),
      occurredAt: requiredText(row, method, "occurred_at", "occurred_at", "occurredAt", "created_at"), evidence: object(row.evidence) ? row.evidence : {},
    };
  }) };
}

export function parseCatalog(value: unknown): CommercialPage<CommercialCatalogItem> {
  const method = commercialOperationsMethods.catalog;
  const page = pageRows(value, method);
  return { total: page.total, items: page.rows.map((row) => ({
    id: requiredText(row, method, "id", "id", "sku_id"), skuCode: requiredText(row, method, "sku_code", "sku_code", "skuCode", "code"),
    name: requiredText(row, method, "name", "name"), type: requiredText(row, method, "type", "type", "sku_type"),
    visibility: requiredText(row, method, "visibility", "visibility"), version: requiredText(row, method, "version", "version", "sku_version"),
    priceLabel: requiredText(row, method, "price_label", "price_label", "priceLabel"), cycleLabel: optionalText(pick(row, "cycle_label", "cycleLabel")),
    benefitsSummary: requiredText(row, method, "benefits_summary", "benefits_summary", "benefitsSummary"),
    approvalState: requiredText(row, method, "approval_state", "approval_state", "approvalState", "status"),
    validFrom: optionalText(pick(row, "valid_from", "validFrom")), validTo: optionalText(pick(row, "valid_to", "validTo")),
    unresolved: stringArray(row.unresolved),
  })) };
}

export function parseOrders(value: unknown): CommercialPage<CommercialOrderItem> {
  const method = commercialOperationsMethods.orders;
  const page = pageRows(value, method);
  return { total: page.total, items: page.rows.map((row) => ({
    id: requiredText(row, method, "id", "id", "order_id"), workspaceId: requiredText(row, method, "workspace_id", "workspace_id", "workspaceId"),
    skuCode: requiredText(row, method, "sku_code", "sku_code", "skuCode"), skuVersion: requiredText(row, method, "sku_version", "sku_version", "skuVersion"),
    purchasedPoints: finiteNumber(pick(row, "purchased_points", "purchasedPoints")), amountLabel: requiredText(row, method, "amount_label", "amount_label", "amountLabel"),
    channel: optionalText(row.channel), paymentState: requiredText(row, method, "payment_state", "payment_state", "paymentState"),
    grantState: requiredText(row, method, "grant_state", "grant_state", "grantState"), accessRevision: optionalText(pick(row, "access_revision", "accessRevision")),
    createdAt: requiredText(row, method, "created_at", "created_at", "createdAt"), paidAt: optionalText(pick(row, "paid_at", "paidAt")),
    requestId: optionalText(pick(row, "request_id", "requestId")),
  })) };
}

export function parseRates(value: unknown): CommercialPage<CreativePointRateItem> {
  const method = commercialOperationsMethods.rates;
  const page = pageRows(value, method);
  return { total: page.total, items: page.rows.map((row) => ({
    id: requiredText(row, method, "id", "id", "rule_id"), actionCode: requiredText(row, method, "action_code", "action_code", "actionCode"),
    actionLabel: requiredText(row, method, "action_label", "action_label", "actionLabel"), unitLabel: requiredText(row, method, "unit_label", "unit_label", "unitLabel"),
    pointsRule: requiredText(row, method, "points_rule", "points_rule", "pointsRule"), version: requiredText(row, method, "version", "version", "rate_card_version"),
    approvalState: requiredText(row, method, "approval_state", "approval_state", "approvalState", "status"),
    validFrom: optionalText(pick(row, "valid_from", "validFrom")), validTo: optionalText(pick(row, "valid_to", "validTo")),
    blockingReason: optionalText(pick(row, "blocking_reason", "blockingReason")),
  })) };
}

export function parseServices(value: unknown): CommercialPage<ServiceFulfillmentItem> {
  const method = commercialOperationsMethods.services;
  const page = pageRows(value, method);
  return { total: page.total, items: page.rows.map((row) => ({
    id: requiredText(row, method, "id", "id"), workspaceId: requiredText(row, method, "workspace_id", "workspace_id", "workspaceId"),
    serviceType: requiredText(row, method, "service_type", "service_type", "serviceType"), allocationLabel: requiredText(row, method, "allocation_label", "allocation_label", "allocationLabel"),
    usedLabel: requiredText(row, method, "used_label", "used_label", "usedLabel"), scheduleAt: optionalText(pick(row, "schedule_at", "scheduleAt")),
    status: requiredText(row, method, "status", "status"), ownerLabel: optionalText(pick(row, "owner_label", "ownerLabel")),
    evidenceLabel: optionalText(pick(row, "evidence_label", "evidenceLabel")), updatedAt: optionalText(pick(row, "updated_at", "updatedAt")),
  })) };
}

export function parseCommercialTimeline(value: unknown): CommercialPage<CommercialTimelineEvent> {
  const method = commercialOperationsMethods.timeline;
  const page = pageRows(value, method);
  return { total: page.total, items: page.rows.map((row) => ({
    id: requiredText(row, method, "id", "id"), workspaceId: requiredText(row, method, "workspace_id", "workspace_id", "workspaceId"),
    kind: requiredText(row, method, "kind", "kind", "event_type", "eventType"), status: requiredText(row, method, "status", "status"),
    occurredAt: requiredText(row, method, "occurred_at", "occurred_at", "occurredAt", "created_at", "createdAt"),
    operationId: optionalText(pick(row, "operation_id", "operationId")), traceId: optionalText(pick(row, "trace_id", "traceId")),
    requestId: optionalText(pick(row, "request_id", "requestId")), actorId: optionalText(pick(row, "actor_id", "actorId")),
    reason: optionalText(row.reason), resourceId: optionalText(pick(row, "resource_id", "resourceId")),
    evidence: object(row.evidence) ? row.evidence : {},
  })) };
}

export function parseCommercialReadiness(value: unknown): CommercialReadinessReport {
  const method = commercialOperationsMethods.readiness;
  if (!object(value)) invalid(method, "结果必须是对象");
  const ready = boolean(value.ready);
  if (ready === null) invalid(method, "ready 缺失");
  const blockers = Array.isArray(value.blockers) ? value.blockers.filter(object).map((row) => ({
    code: requiredText(row, method, "code", "code"),
    severity: requiredText(row, method, "severity", "severity"),
    scope: requiredText(row, method, "scope", "scope"),
    detail: requiredText(row, method, "detail", "detail"),
    nextAction: requiredText(row, method, "next_action", "next_action", "nextAction"),
  })) : [];
  const registry = Array.isArray(value.registry) ? value.registry.filter(object).map((row) => {
    const enabled = boolean(row.enabled);
    if (enabled === null) invalid(method, "registry.enabled 缺失");
    return { operation: requiredText(row, method, "operation", "operation"), enabled };
  }) : [];
  return {
    ready,
    environment: requiredText(value, method, "environment", "environment"),
    message: requiredText(value, method, "message", "message"),
    generatedAt: optionalText(pick(value, "generated_at", "generatedAt")),
    blockers,
    capabilities: object(value.capabilities) ? Object.fromEntries(Object.entries(value.capabilities).filter(([, entry]) => object(entry))) as Record<string, RecordValue> : {},
    catalog: object(value.catalog) ? value.catalog : {},
    policies: object(value.policies) ? value.policies : {},
    registry,
    provider: object(value.provider) ? value.provider : {},
    creativePoints: object(value.creative_points) ? value.creative_points : {},
  };
}

export const commercialOperationsClient = {
  summary: async (targetWorkspaceId: string, signal?: AbortSignal) => parseCommercialAccessSummary(await rpc(commercialOperationsMethods.accessSummary, { target_workspace_id: targetWorkspaceId }, { signal })),
  blocks: async (targetWorkspaceId: string, signal?: AbortSignal) => parseAccessBlocks(await rpc(commercialOperationsMethods.accessBlocks, { target_workspace_id: targetWorkspaceId, status: "open", limit: "100" }, { signal })),
  entitlements: async (targetWorkspaceId: string, signal?: AbortSignal) => parseEntitlements(await rpc(commercialOperationsMethods.entitlements, { target_workspace_id: targetWorkspaceId, limit: "100" }, { signal })),
  ledger: async (targetWorkspaceId: string, signal?: AbortSignal) => parseLedger(await rpc(commercialOperationsMethods.ledger, { target_workspace_id: targetWorkspaceId, limit: "100" }, { signal })),
  catalog: async (_targetWorkspaceId: string, includePrivate: boolean, signal?: AbortSignal) => parseCatalog(await rpc(commercialOperationsMethods.catalog, { limit: "100", include_private: String(includePrivate) }, { signal })),
  orders: async (targetWorkspaceId: string, signal?: AbortSignal) => parseOrders(await rpc(commercialOperationsMethods.orders, { target_workspace_id: targetWorkspaceId, limit: "100" }, { signal })),
  rates: async (_targetWorkspaceId: string, signal?: AbortSignal) => parseRates(await rpc(commercialOperationsMethods.rates, { limit: "100" }, { signal })),
  services: async (targetWorkspaceId: string, signal?: AbortSignal) => parseServices(await rpc(commercialOperationsMethods.services, { target_workspace_id: targetWorkspaceId, limit: "100" }, { signal })),
  timeline: async (targetWorkspaceId: string, inputOrSignal?: { from?: string; to?: string; status?: string } | AbortSignal, signal?: AbortSignal) => {
    const isSignal = typeof AbortSignal !== "undefined" && inputOrSignal instanceof AbortSignal;
    const input = isSignal ? {} : (inputOrSignal as { from?: string; to?: string; status?: string } | undefined ?? {});
    const requestSignal = isSignal ? inputOrSignal : signal;
    return parseCommercialTimeline(await rpc(commercialOperationsMethods.timeline, { target_workspace_id: targetWorkspaceId, limit: "200", ...(input.from ? { from_at: input.from } : {}), ...(input.to ? { to_at: input.to } : {}), ...(input.status ? { status: input.status } : {}) }, { signal: requestSignal }));
  },
  readiness: async (signal?: AbortSignal) => parseCommercialReadiness(await rpc(commercialOperationsMethods.readiness, {}, { signal })),
  createPrivateTrialEligibility: (workspace: string, customerRef: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialEligibilityCreate, { target_workspace_id: workspace, customer_ref: customerRef, idempotency_key: operationId("private_trial_eligibility"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "create" }) }, { signal }),
  approvePrivateTrialEligibility: (workspace: string, eligibilityId: string, expectedRevision: number, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialEligibilityApprove, { target_workspace_id: workspace, eligibility_id: eligibilityId, expected_revision: String(expectedRevision), idempotency_key: operationId("private_trial_approve"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "business_approve" }) }, { signal }),
  completePrivateTrialValidation: (workspace: string, eligibilityId: string, trialOrderId: string, completedAt: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialValidationComplete, { target_workspace_id: workspace, eligibility_id: eligibilityId, trial_order_id: trialOrderId, completed_at: completedAt, idempotency_key: operationId("private_trial_validation"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "validation_complete" }) }, { signal }),
  preparePrivateTrialCredit: (workspace: string, eligibilityId: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialCreditPrepare, { target_workspace_id: workspace, eligibility_id: eligibilityId, idempotency_key: operationId("private_trial_credit_prepare"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "prepare_credit" }) }, { signal }),
  approvePrivateTrialCredit: (workspace: string, creditId: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialCreditApprove, { target_workspace_id: workspace, credit_id: creditId, idempotency_key: operationId("private_trial_credit_approve"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "accounting_approve" }) }, { signal }),
  createPrivateTrialConversionOrder: (workspace: string, creditId: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialConversionCreate, { target_workspace_id: workspace, credit_id: creditId, idempotency_key: operationId("private_trial_conversion"), reason }, { signal }),
  verifyPrivateTrialTransfer: (workspace: string, creditId: string, orderId: string, paymentSubjectRef: string, providerEventId: string, providerOrderId: string, nonce: string, payloadHash: string, paidAt: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialPaymentVerify, { target_workspace_id: workspace, credit_id: creditId, order_id: orderId, payment_subject_ref: paymentSubjectRef, provider_event_id: providerEventId, provider_order_id: providerOrderId, nonce, payload_hash: payloadHash, paid_at: paidAt, idempotency_key: operationId("private_trial_transfer_verify"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "manual_transfer_verified" }) }, { signal }),
  verifyCommercialOrderTransfer: (workspace: string, orderId: string, paymentSubjectRef: string, providerEventId: string, providerOrderId: string, nonce: string, payloadHash: string, paidAt: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.orderPaymentVerify, { target_workspace_id: workspace, order_id: orderId, payment_subject_ref: paymentSubjectRef, provider_event_id: providerEventId, provider_order_id: providerOrderId, nonce, payload_hash: payloadHash, paid_at: paidAt, idempotency_key: operationId("commercial_order_transfer_verify"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "commercial_order_manual_transfer_verified" }) }, { signal }),
  listCommercialRefunds: (workspace: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.refundList, { target_workspace_id: workspace, limit: "100" }, { signal }),
  requestCommercialRefund: (input: { workspace: string; orderId: string; requestId: string; kind: CommercialRefundKind; amountFen: number; pointsToRevoke: number; reason: string; evidenceRef: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.refundRequest, { target_workspace_id: input.workspace, order_id: input.orderId, request_id: input.requestId, refund_kind: input.kind, amount_fen: String(input.amountFen), points_to_revoke: String(input.pointsToRevoke), reason: input.reason, evidence_json: JSON.stringify(commercialRefundEvidence(input.kind, input.evidenceRef)) }, { signal }),
  approveCommercialRefund: (workspace: string, requestId: string, policyApproval: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.refundApprove, { target_workspace_id: workspace, request_id: requestId, reason, policy_approval_json: JSON.stringify(refundPolicyApproval(policyApproval)) }, { signal }),
  completeCommercialRefund: (workspace: string, requestId: string, externalRefundId: string, evidenceJson: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.refundComplete, { target_workspace_id: workspace, request_id: requestId, external_refund_id: externalRefundId, reason, evidence_json: evidenceJson }, { signal }),
  proposePointAdjustment: async (targetWorkspaceId: string, pointsDelta: number, reason: string, signal?: AbortSignal) => rpc("ops.commercial.points.adjust.propose", { target_workspace_id: targetWorkspaceId, points_delta: String(pointsDelta), expected_revision: "0", idempotency_key: operationId("point_adjust_propose"), reason, evidence_json: JSON.stringify({ source: "ops_console", mode: "test" }) }, { signal }),
  decidePointAdjustment: async (targetWorkspaceId: string, proposalId: string, decision: "approved" | "rejected", reason: string, signal?: AbortSignal) => rpc("ops.commercial.points.adjust.decide", { target_workspace_id: targetWorkspaceId, proposal_id: proposalId, decision, idempotency_key: operationId("point_adjust_decide"), reason, evidence_json: JSON.stringify({ source: "ops_console", mode: "test" }) }, { signal }),
  scheduleService: (workspace: string, allocation: string, revision: number, scheduleAt: string, reason: string) => serviceCommand("ops.commercial.service-fulfillment.schedule", workspace, allocation, revision, reason, { schedule_at: scheduleAt }),
  startService: (workspace: string, allocation: string, revision: number, reason: string) => serviceCommand("ops.commercial.service-fulfillment.start", workspace, allocation, revision, reason),
  completeService: (workspace: string, allocation: string, revision: number, quantity: number, reason: string) => serviceCommand("ops.commercial.service-fulfillment.complete", workspace, allocation, revision, reason, { actual_quantity: String(quantity) }),
  adjustService: (workspace: string, allocation: string, revision: number, eventId: string, quantity: number, reason: string) => serviceCommand("ops.commercial.service-fulfillment.adjust", workspace, allocation, revision, reason, { corrects_event_id: eventId, actual_quantity: String(quantity) }),
  createServiceAllocation,
};

export type CommercialOperationsClient = typeof commercialOperationsClient;
