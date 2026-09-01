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
} as const;

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

export interface CommercialPage<T> { items: T[]; total: number }

export function parseCommercialAccessSummary(value: unknown): CommercialAccessSummary {
  const method = commercialOperationsMethods.accessSummary;
  if (!object(value)) invalid(method, "结果必须是对象");
  const allowed = boolean(value.allowed);
  if (allowed === null) invalid(method, "allowed 缺失");
  return {
    decisionId: requiredText(value, method, "decision_id", "decision_id", "decisionId"),
    workspaceId: requiredText(value, method, "workspace_id", "workspace_id", "workspaceId"),
    balanceState: requiredText(value, method, "balance_state", "balance_state", "balanceState"),
    availablePoints: finiteNumber(pick(value, "available_points", "availablePoints")),
    reservedPoints: finiteNumber(pick(value, "reserved_points", "reservedPoints")),
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

export const commercialOperationsClient = {
  summary: async (signal?: AbortSignal) => parseCommercialAccessSummary(await rpc(commercialOperationsMethods.accessSummary, {}, { signal })),
  blocks: async (signal?: AbortSignal) => parseAccessBlocks(await rpc(commercialOperationsMethods.accessBlocks, { status: "open", limit: "100" }, { signal })),
  entitlements: async (signal?: AbortSignal) => parseEntitlements(await rpc(commercialOperationsMethods.entitlements, { limit: "100" }, { signal })),
  ledger: async (signal?: AbortSignal) => parseLedger(await rpc(commercialOperationsMethods.ledger, { limit: "100" }, { signal })),
  catalog: async (includePrivate: boolean, signal?: AbortSignal) => parseCatalog(await rpc(commercialOperationsMethods.catalog, { limit: "100", include_private: String(includePrivate) }, { signal })),
  orders: async (signal?: AbortSignal) => parseOrders(await rpc(commercialOperationsMethods.orders, { limit: "100" }, { signal })),
  rates: async (signal?: AbortSignal) => parseRates(await rpc(commercialOperationsMethods.rates, { limit: "100" }, { signal })),
  services: async (signal?: AbortSignal) => parseServices(await rpc(commercialOperationsMethods.services, { limit: "100" }, { signal })),
};

export type CommercialOperationsClient = typeof commercialOperationsClient;
