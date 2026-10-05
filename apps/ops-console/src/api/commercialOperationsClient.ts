import { rpc, type OpsRpcOptions } from "./opsClient.js";

export const commercialOperationsMethods = {
  accessSummary: "ops.commercial.access.summary",
  accessBlocks: "ops.commercial.access-blocks.list",
  entitlements: "ops.commercial.entitlements.list",
  ledger: "ops.commercial.points-ledger.list",
  catalog: "ops.commercial.catalog-v2.list",
  catalogMutate: "ops.commercial.catalog-v2.mutate",
  benefitDefinitions: "ops.commercial.benefit-definitions.list",
  benefitBundles: "ops.commercial.benefit-bundles.list",
  benefitBundleMutate: "ops.commercial.benefit-bundles.mutate",
  benefitBundleReferences: "ops.commercial.benefit-bundles.references.list",
  assistedOrderPreview: "ops.commercial.order.preview",
  assistedOrderCreate: "ops.commercial.order.create",
  assistedOrderRequest: "ops.commercial.order.request.get",
  assistedQuoteRequest: "ops.commercial.upgrade.quote.request.get",
  assistedCheckoutPreview: "ops.commercial.checkout.preview",
  assistedCheckoutCreate: "ops.commercial.checkout.create",
  assistedUpgradeQuoteCreate: "ops.commercial.upgrade.quote.create",
  assistedUpgradeQuoteGet: "ops.commercial.upgrade.quote.get",
  orders: "ops.commercial.orders-v2.list",
  rates: "ops.commercial.rate-cards.list",
  services: "ops.commercial.service-fulfillment.list",
  timeline: "ops.commercial.timeline.list",
  readiness: "ops.commercial.readiness.report",
  privateTrialEligibilityCreate: "ops.commercial.private-trial.eligibility.create",
  privateTrialOrderCreate: "ops.commercial.private-trial.order.create",
  privateTrialTrialPaymentVerify: "ops.commercial.private-trial.trial-payment.verify",
  privateTrialInviteCreate: "ops.commercial.private-trial.invite.create",
  privateTrialInviteList: "ops.commercial.private-trial.invite.list",
  privateTrialInviteRevoke: "ops.commercial.private-trial.invite.revoke",
  privateTrialEligibilityApprove: "ops.commercial.private-trial.eligibility.approve",
  privateTrialValidationComplete: "ops.commercial.private-trial.validation.complete",
  privateTrialCreditPrepare: "ops.commercial.private-trial.credit.prepare",
  privateTrialCreditApprove: "ops.commercial.private-trial.credit.approve",
  privateTrialConversionCreate: "ops.commercial.private-trial.conversion.create",
  privateTrialPaymentVerify: "ops.commercial.private-trial.payment.verify",
  orderPaymentVerify: "ops.commercial.order.payment.verify",
  unmatchedReceiptRecord: "ops.commercial.receipt.unmatched.record",
  unmatchedReceiptList: "ops.commercial.receipt.unmatched.list",
  unmatchedReceiptMatch: "ops.commercial.receipt.unmatched.match",
  receiptRecord: "ops.commercial.receipt.record",
  receiptList: "ops.commercial.receipt.list",
  receiptGet: "ops.commercial.receipt.get",
  allocationPreview: "ops.commercial.receipt.allocation.preview",
  allocationConfirm: "ops.commercial.receipt.allocation.confirm",
  receiptReturnPropose: "ops.commercial.receipt.return.propose",
  receiptReturnDecide: "ops.commercial.receipt.return.decide",
  receiptReturnComplete: "ops.commercial.receipt.return.complete",
  receiptReturnList: "ops.commercial.receipt.return.list",
  refundList: "ops.commercial.order.refund.list",
  refundRequest: "ops.commercial.order.refund.request",
  refundApprove: "ops.commercial.order.refund.approve",
  refundComplete: "ops.commercial.order.refund.complete",
} as const;

export type CommercialRefundKind = "onboarding_pre_deployment" | "monthly_unused_points" | "point_pack_unused_points" | "outage_compensation" | "custom_milestone";

export async function refundOperationKey(action: "request" | "approve" | "complete", workspace: string, requestId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([workspace, action, requestId]))));
  return `commercial.refund.${action}:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

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

/** Exact decimal input: receipt amounts must never round a third decimal or become zero. */
export function positiveCommercialFen(value: string): number {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/u.exec(value.trim());
  if (!match) throw new Error("金额须为正数，最多两位小数");
  const fen = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (fen < 1n || fen > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("金额超出合法整数分范围");
  return Number(fen);
}

const operationId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const SERVICE_BOUNDARY_POLICY_CHECKSUM = "94cd78089cf960d4b556ed9990fcd653c03473bd143b94d0203ab978ea84d685";

/**
 * The service-fulfilment writes carry the `approval` authorization obligation,
 * and the API resolves the approver ONLY from the maker-checker token grant in
 * the `x-authorization-approval-token` header (`verifiedApprovalActor` in
 * apps/api/src/server.ts). Under strict auth a command sent without that header
 * is rejected, so a body `approved_by` would not be evidence and the console's
 * service controls would be dead.
 *
 * The token is an explicit parameter at every layer — never read from ambient
 * session state, because an approval is the act of a named approver, not
 * whatever identity happens to be active. An empty/whitespace token is treated
 * as "no token" so callers can pass a blank form field without fabricating a
 * header.
 */
const approvalOptions = (approvalToken?: string): OpsRpcOptions => {
  const token = approvalToken?.trim();
  return token ? { authorizationApprovalToken: token } : {};
};

const serviceCommand = async (method: string, targetWorkspaceId: string, allocationId: string, expectedRevision: number, reason: string, extra: Record<string, string> = {}, approvalToken?: string) => rpc(method, { target_workspace_id: targetWorkspaceId, allocation_id: allocationId, expected_revision: String(expectedRevision), idempotency_key: operationId("service_fulfillment"), reason, evidence_json: JSON.stringify({ source: "ops_console", mode: "test" }), ...extra }, approvalOptions(approvalToken));

/**
 * `approvalToken` is a trailing argument, never a field of `input`, for the same
 * reason it is never read from ambient state: `input` is the object the
 * JSON-RPC params are derived from, and the approver's bearer token must never
 * travel as a param, where it would be logged, traced and echoed back in
 * evidence. The params literal below is explicit today, so no spread leaks it —
 * but with the token inside `input`, a later `...input` spread would put it on
 * the wire. Keeping it out of the shape makes that accident impossible instead
 * of merely absent. The other four service writes already take it this way.
 */
const createServiceAllocation = async (input: { workspace: string; order: string; entitlement: string; serviceType: string; unit: string; quantity: number; checksum: string; reason: string; acceptanceRef: string; customerSubjectRef: string; acceptedAt: string }, approvalToken?: string) => rpc("ops.commercial.service-allocation.create", { target_workspace_id: input.workspace, order_snapshot_id: input.order, entitlement_snapshot_id: input.entitlement, service_type: input.serviceType, unit: input.unit, allocated_quantity: String(input.quantity), source_checksum: input.checksum, expected_revision: "0", idempotency_key: operationId("service_allocation_create"), reason: input.reason, evidence_json: JSON.stringify({ source: "ops_console", service_boundary_acceptance: { accepted: true, policy_version: "commercial.service-boundary.v1", policy_checksum: SERVICE_BOUNDARY_POLICY_CHECKSUM, acceptance_ref: input.acceptanceRef, customer_subject_ref: input.customerSubjectRef, accepted_at: input.acceptedAt } }) }, approvalOptions(approvalToken));

export const commercialCapabilities = {
  accessRead: "commercial.access.read",
  accessRecover: "commercial.access.recover",
  entitlementRead: "commercial.entitlement.read",
  pointRead: "commercial.point.read",
  pointAdjust: "commercial.point.adjust",
  catalogRead: "commercial.catalog.read",
  catalogDraft: "commercial.catalog.draft",
  catalogPublish: "commercial.catalog.publish",
  catalogApprove: "commercial.catalog.approve",
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

function pageRows(value: unknown, method: string): { rows: RecordValue[]; total: number; truncated: boolean; nextCursor: string | null } {
  const rows = Array.isArray(value) ? value : object(value) && Array.isArray(value.items) ? value.items : null;
  if (!rows || !rows.every(object)) invalid(method, "items 必须是对象数组");
  const rawTotal = object(value) ? finiteNumber(value.total) : null;
  const total = rawTotal ?? rows.length;
  if (!Number.isSafeInteger(total) || total < rows.length) invalid(method, "total 必须是不小于当前页条数的整数");
  const nextCursor = object(value) && value.next_cursor !== undefined
    ? (value.next_cursor === null ? null : text(value.next_cursor) ? value.next_cursor : invalid(method, "next_cursor 必须是字符串或 null"))
    : null;
  const truncated = object(value) && value.truncated !== undefined
    ? (typeof value.truncated === "boolean" ? value.truncated : invalid(method, "truncated 必须是布尔值"))
    : false;
  if (total > rows.length && !truncated && !nextCursor) invalid(method, "服务端返回了不完整 total，但没有分页继续证据");
  return { rows, total, truncated, nextCursor };
}

export interface CommercialPageRequest { cursor?: string; limit?: number }
export type CommercialPageInput = CommercialPageRequest | AbortSignal | undefined;

function pageRequest(input: CommercialPageInput, signal?: AbortSignal): { params: Record<string, string>; signal?: AbortSignal } {
  const isSignal = typeof AbortSignal !== "undefined" && input instanceof AbortSignal;
  const options: CommercialPageRequest = isSignal ? {} : (input as CommercialPageRequest | undefined) ?? {};
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("商业运营分页 limit 必须是 1 到 100 的整数");
  return {
    params: { limit: String(limit), ...(options.cursor?.trim() ? { cursor: options.cursor.trim() } : {}) },
    ...(isSignal ? { signal: input } : signal ? { signal } : {}),
  };
}

const pageMeta = (page: { total: number; truncated: boolean; nextCursor: string | null }) => ({ total: page.total, truncated: page.truncated, nextCursor: page.nextCursor });

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
  sourceOrderStatus: string | null;
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
  /** Server-priced amount in fen; absent only for legacy unparsed responses. */
  priceFen?: number | null;
  cycleLabel: string | null;
  durationDays?: number | null;
  priceMode?: string | null;
  benefitsSummary: string;
  benefits?: Array<{ code: string; quantity: number | null; rawValue: string | null; rawUnit: string | null; normalizedValue?: number | null; policyRef?: string | null; metadata?: Record<string, unknown> }>;
  approvalState: string;
  executable?: boolean;
  /** Current sale projection; never inferred from a historical approved row. */
  currentSaleState?: string | null;
  currentSaleVersionId?: string | null;
  saleRevision?: number | null;
  payload?: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  unresolved: string[];
}

export type CommercialCatalogAction = "create" | "submit" | "approve" | "reject" | "publish" | "retire" | "archive" | "delete_draft";
export interface CommercialCatalogManagementInput {
  cursor?: string;
  limit?: number;
  kind?: "onboarding" | "monthly" | "point_pack" | "private_trial";
  saleState?: "unlisted" | "on_sale" | "off_sale" | "archived" | "deleted";
  search?: string;
}
export interface CommercialBenefitBundle {
  id: string; code: string; versionId: string; version: number; name: string;
  usage: "included" | "standalone"; lifecycle: string; benefits: Record<string, unknown>[];
  payload: Record<string, unknown>; checksum: string; revision: number; state: string;
}
export function parseBenefitBundles(value: unknown): CommercialPage<CommercialBenefitBundle> {
  const method = commercialOperationsMethods.benefitBundles;
  const page = pageRows(value, method);
  return { ...pageMeta(page), items: page.rows.map(row => {
    const version = finiteNumber(row.version), revision = finiteNumber(row.revision);
    if (!Number.isSafeInteger(version) || version === null || version < 1 || !Number.isSafeInteger(revision) || revision === null || revision < 0) invalid(method, "版本或revision无效");
    if (row.usage !== "included" && row.usage !== "standalone") invalid(method, "usage无效");
    if (!Array.isArray(row.benefits) || !row.benefits.every(object)) invalid(method, "benefits必须是对象数组");
    return { id: requiredText(row, method, "id", "id"), code: requiredText(row, method, "code", "code"), versionId: requiredText(row, method, "versionId", "versionId", "version_id"), version, revision,
      name: requiredText(row, method, "name", "name"), usage: row.usage, lifecycle: requiredText(row, method, "lifecycle", "lifecycle"), state: requiredText(row, method, "state", "state"),
      benefits: row.benefits, payload: object(row.payload) ? row.payload : {}, checksum: requiredText(row, method, "checksum", "checksum") };
  }) };
}

function validatedCommercialTime(value: unknown, method: string, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(method,`${field}时间无效`);
  return value;
}
export interface AssistedOrderInput { workspace: string; beneficiaryMemberId: string; skuCode: string; purchaseKind: "onboarding_once" | "purchase" | "renewal" | "upgrade" | "point_pack"; upgradeQuoteId?: string; checkoutId?: string; onboardingOrderId?: string; reason: string }
const assistedOrderParams = (input: AssistedOrderInput) => ({ target_workspace_id: input.workspace, beneficiary_member_id: input.beneficiaryMemberId, sku_code: input.skuCode, purchase_kind: input.purchaseKind, ...(input.upgradeQuoteId ? { upgrade_quote_id: input.upgradeQuoteId } : {}), ...(input.checkoutId ? { checkout_id: input.checkoutId } : {}), ...(input.onboardingOrderId ? { onboarding_order_id: input.onboardingOrderId } : {}), reason: input.reason });
export interface AssistedOrderPreview {
  workspaceId: string; skuCode: string; purchaseKind: AssistedOrderInput["purchaseKind"]; amountFen: number; previewHash: string; expiresAt: string; reason: string;
  name: string; versionId: string; cycle: unknown; benefits: unknown[]; onboardingQualified: boolean; current: unknown; future: unknown[];
}
export function parseAssistedOrderPreview(value: unknown): AssistedOrderPreview {
  const method = commercialOperationsMethods.assistedOrderPreview;
  if (!object(value) || !object(value.snapshot) || value.currency !== "CNY" || !Array.isArray(value.snapshot.benefits) || !Array.isArray(value.future) || typeof value.onboarding_qualified !== "boolean") invalid(method, "服务端商品、客户或依赖快照缺失");
  const amountFen = finiteNumber(value.amount_fen);
  if (amountFen === null || !Number.isSafeInteger(amountFen) || amountFen < 0) invalid(method, "订单金额无效");
  const purchaseKind = requiredText(value,method,"purchase_kind","purchase_kind");
  if (!["onboarding_once","purchase","renewal","upgrade","point_pack"].includes(purchaseKind)) invalid(method,"购买意图无效");
  return { workspaceId: requiredText(value,method,"workspace_id","workspace_id"), skuCode: requiredText(value,method,"sku_code","sku_code"), purchaseKind: purchaseKind as AssistedOrderInput["purchaseKind"], amountFen, previewHash: requiredText(value,method,"preview_hash","preview_hash"), expiresAt: validatedCommercialTime(value.expires_at,method,"expires_at"), reason: requiredText(value,method,"reason","reason"), name: requiredText(value.snapshot,method,"name","name"), versionId: requiredText(value.snapshot,method,"version_id","version_id"), cycle: value.snapshot.cycle, benefits: value.snapshot.benefits, onboardingQualified: value.onboarding_qualified, current: value.current ?? null, future: value.future };
}
export interface AssistedUpgradeQuote { id: string; workspaceId: string; targetSkuCode: string; amountFen: number; currentCyclePriceFen: number; targetCyclePriceFen: number; periodStart: string; periodEnd: string; remainingMs: number; totalMs: number; expiresAt: string; benefitIncrements: unknown[] }
export function parseAssistedUpgradeQuote(value: unknown): AssistedUpgradeQuote {
  const method = commercialOperationsMethods.assistedUpgradeQuoteGet;
  if (!object(value)) invalid(method,"升级报价缺失");
  const increments = pick(value,"benefit_increment_details","benefitIncrements");
  if (!Array.isArray(increments)) invalid(method,"升级增量权益明细缺失");
  const result = { id: requiredText(value,method,"upgrade_quote_id","upgrade_quote_id","id"), workspaceId: requiredText(value,method,"workspace_id","workspace_id","workspaceId"), targetSkuCode: requiredText(value,method,"target_sku_code","target_sku_code","targetSkuCode"), amountFen: finiteNumber(pick(value,"amount_fen","amountFen")), currentCyclePriceFen: finiteNumber(pick(value,"current_cycle_price_fen","currentCyclePriceFen")), targetCyclePriceFen: finiteNumber(pick(value,"target_cycle_price_fen","targetCyclePriceFen")), remainingMs: finiteNumber(pick(value,"remaining_ms","remainingMs")), totalMs: finiteNumber(pick(value,"total_ms","totalMs")), periodStart: validatedCommercialTime(pick(value,"period_start","periodStart"),method,"period_start"), periodEnd: validatedCommercialTime(pick(value,"period_end","periodEnd"),method,"period_end"), expiresAt: validatedCommercialTime(pick(value,"expires_at","expiresAt"),method,"expires_at"), benefitIncrements: increments };
  for (const key of ["amountFen","currentCyclePriceFen","targetCyclePriceFen","remainingMs","totalMs"] as const) if (result[key] === null || !Number.isSafeInteger(result[key]) || result[key]! < 0) invalid(method,"升级报价金额或剩余期无效");
  if (!result.totalMs || result.remainingMs! > result.totalMs || Date.parse(result.periodStart) >= Date.parse(result.periodEnd)) invalid(method,"升级原周期无效");
  return result as AssistedUpgradeQuote;
}
export interface AssistedCheckoutPreview { workspaceId: string; amountFen: number; previewHash: string; expiresAt: string; reason: string; onboardingQualified: boolean; current: unknown; future: unknown[]; lines: Array<{ kind: "onboarding_once" | "purchase"; skuCode: string; name: string; versionId: string; amountFen: number; cycle: unknown; benefits: unknown[]; dependsOn: string | null }> }
export function parseAssistedCheckoutPreview(value: unknown): AssistedCheckoutPreview {
  const method = commercialOperationsMethods.assistedCheckoutPreview;
  if (!object(value) || value.currency !== "CNY" || !Array.isArray(value.lines) || value.lines.length !== 2 || !Array.isArray(value.future) || typeof value.onboarding_qualified !== "boolean") invalid(method,"首购联合快照不完整");
  const lines = value.lines.map(row => {
    if (!object(row) || !object(row.snapshot) || !Array.isArray(row.snapshot.benefits) || !["onboarding_once","purchase"].includes(String(row.purchase_kind))) invalid(method,"首购行快照无效");
    const amountFen = finiteNumber(row.amount_fen);
    if (amountFen === null || !Number.isSafeInteger(amountFen) || amountFen <= 0 || (row.purchase_kind === "purchase" && row.depends_on !== "onboarding_once")) invalid(method,"首购金额或依赖无效");
    return { kind: row.purchase_kind as "onboarding_once" | "purchase", amountFen, skuCode:requiredText(row.snapshot,method,"sku_code","sku_code"),name:requiredText(row.snapshot,method,"name","name"),versionId:requiredText(row.snapshot,method,"version_id","version_id"),cycle:row.snapshot.cycle,benefits:row.snapshot.benefits,dependsOn:optionalText(row.depends_on) };
  });
  const amountFen = finiteNumber(value.amount_fen);
  if (new Set(lines.map(line => line.kind)).size !== 2 || amountFen !== lines.reduce((sum,line) => sum + line.amountFen,0) || amountFen === null || !Number.isSafeInteger(amountFen)) invalid(method,"首购合计金额不守恒");
  return { workspaceId: requiredText(value,method,"workspace_id","workspace_id"),amountFen,previewHash:requiredText(value,method,"preview_hash","preview_hash"),expiresAt:validatedCommercialTime(value.expires_at,method,"expires_at"),reason:requiredText(value,method,"reason","reason"),onboardingQualified:value.onboarding_qualified,current:value.current ?? null,future:value.future,lines };
}

export interface CommercialAllocationPreview {
  workspaceId: string; previewHash: string; expiresAt: string; receipt: CommercialCashReceipt;
  orderId: string; orderAmountFen: number; skuCode: string; amountFen: number; expectedRevision: number; availableAfterFen: number; fulfillmentState: string;
}
export function parseAllocationPreview(value: unknown): CommercialAllocationPreview {
  const method = commercialOperationsMethods.allocationPreview;
  if (!object(value) || !object(value.order)) invalid(method, "缺少服务端分配明细");
  const receipt = parseCommercialReceipt(value.receipt);
  const workspaceId = requiredText(value, method, "workspace_id", "workspace_id");
  const amountFen = finiteNumber(value.amount_fen), availableAfterFen = finiteNumber(value.available_after_fen), expectedRevision = finiteNumber(value.expected_revision), orderAmountFen = finiteNumber(pick(value.order,"amountFen","amount_fen"));
  if ([amountFen,availableAfterFen,expectedRevision,orderAmountFen].some(item => item === null || !Number.isSafeInteger(item) || item < 0) || amountFen === null || amountFen <= 0 || orderAmountFen === null || availableAfterFen === null || expectedRevision === null || expectedRevision !== receipt.revision || workspaceId !== receipt.workspaceId || receipt.availableFen - amountFen !== availableAfterFen) invalid(method, "金额、企业或revision不一致");
  return { workspaceId, receipt, previewHash: requiredText(value,method,"preview_hash","preview_hash"), expiresAt: validatedCommercialTime(value.expires_at,method,"expires_at"), orderId: requiredText(value.order,method,"orderId","id","order_id"), orderAmountFen, skuCode: requiredText(value,method,"sku_code","sku_code"), amountFen, expectedRevision, availableAfterFen, fulfillmentState: requiredText(value,method,"fulfillment_state","fulfillment_state") };
}

export interface CashAllocationLine { receipt_id: string; order_id: string; amount_fen: number; expected_revision: number }
export interface CashAllocationBatchPreview { items: CommercialAllocationPreview[]; previewHash: string; expiresAt: string }
export function parseAllocationBatchPreview(value: unknown): CashAllocationBatchPreview {
  const method = "ops.commercial.receipt.allocations.preview";
  if (!object(value) || !Array.isArray(value.items) || !value.items.length) invalid(method,"批次明细缺失");
  const items = value.items.map(parseAllocationPreview);
  if (new Set(items.map(item => item.workspaceId)).size !== 1) invalid(method,"批次跨企业");
  const byReceipt = new Map<string, { amount: number; available: number }>();
  for (const item of items) { const current = byReceipt.get(item.receipt.id) ?? { amount: 0, available: item.receipt.availableFen }; current.amount += item.amountFen; if (!Number.isSafeInteger(current.amount) || current.available !== item.receipt.availableFen || current.amount > current.available) invalid(method,"同笔收款的批次分配超出可用余款"); byReceipt.set(item.receipt.id,current); }
  return { items, previewHash: requiredText(value,method,"preview_hash","preview_hash"), expiresAt: validatedCommercialTime(value.expires_at,method,"expires_at") };
}
export interface CommercialCashReceipt {
  id: string; workspaceId: string; source: string; receivingAccountRef: string; externalTradeId: string; payerRef: string;
  amountFen: number; currency: "CNY"; receivedAt: string; verifiedAt: string;
  allocatedFen: number; returnedFen: number; frozenReturnFen: number; availableFen: number; revision: number;
}
function parseReceiptFact(value: unknown, ownership: "matched" | "unmatched") {
  const method = commercialOperationsMethods.receiptGet;
  if (!object(value)) invalid(method, "收款事实缺失");
  const row = object(value.receipt) ? value.receipt : object(value.item) ? value.item : value;
  const workspaceId = pick(row,"workspaceId","workspace_id");
  if (ownership === "unmatched" ? workspaceId !== null : !text(workspaceId)) invalid(method,"收款归属范围无效");
  const amounts = ["amountFen", "allocatedFen", "returnedFen", "frozenReturnFen", "availableFen", "revision"] as const;
  const numbers = Object.fromEntries(amounts.map(key => [key, finiteNumber(pick(row, key, key.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`)))])) as Record<typeof amounts[number], number>;
  for (const key of amounts) if (!Number.isSafeInteger(numbers[key]) || numbers[key] < 0) invalid(method, `${key}无效`);
  if (numbers.amountFen < 1 || numbers.revision < 1 || numbers.amountFen !== numbers.allocatedFen + numbers.returnedFen + numbers.frozenReturnFen + numbers.availableFen || row.currency !== "CNY") invalid(method, "收款金额不守恒或币种无效");
  return { ...numbers, id: requiredText(row, method, "id", "id"), workspaceId: workspaceId as string | null, source: requiredText(row, method, "source", "source"), receivingAccountRef: requiredText(row, method, "receivingAccountRef", "receivingAccountRef", "receiving_account_ref"), externalTradeId: requiredText(row, method, "externalTradeId", "externalTradeId", "external_trade_id"), payerRef: requiredText(row, method, "payerRef", "payerRef", "payer_ref"), currency: "CNY", receivedAt: validatedCommercialTime(pick(row,"receivedAt","received_at"),method,"receivedAt"), verifiedAt: validatedCommercialTime(pick(row,"verifiedAt","verified_at"),method,"verifiedAt") };
}
export interface UnmatchedCashReceipt extends Omit<CommercialCashReceipt,"workspaceId"> { workspaceId: null }
export function parseCommercialReceipt(value: unknown): CommercialCashReceipt { return parseReceiptFact(value,"matched") as CommercialCashReceipt; }
export function parseUnmatchedCashReceipt(value: unknown): UnmatchedCashReceipt { return parseReceiptFact(value,"unmatched") as UnmatchedCashReceipt; }
export function parseUnmatchedReceiptPage(value: unknown): CommercialPage<UnmatchedCashReceipt> {
  const page = pageRows(value,commercialOperationsMethods.unmatchedReceiptList);
  return {...pageMeta(page),items:page.rows.map(parseUnmatchedCashReceipt)};
}
export interface UnmatchedReceiptRecordInput { receivingAccountRef: string; externalTradeId: string; payerRef: string; amountFen: number; receivedAt: string; evidenceRef: string; reason: string }

export interface CommercialCashReturn { id: string; receiptId: string; amountFen: number; payerRef: string; status: string; requestedByActorId: string; approvedByActorId: string | null; externalReturnId: string | null }
export function parseCommercialReturns(value: unknown): CommercialCashReturn[] {
  return pageRows(value, commercialOperationsMethods.receiptReturnList).rows.map(row => {
    const amountFen = finiteNumber(pick(row, "amountFen", "amount_fen"));
    if (amountFen === null || !Number.isSafeInteger(amountFen) || amountFen < 1) invalid(commercialOperationsMethods.receiptReturnList, "返款金额无效");
    return { id: requiredText(row, commercialOperationsMethods.receiptReturnList, "id", "id"), receiptId: requiredText(row, commercialOperationsMethods.receiptReturnList, "receiptId", "receiptId", "receipt_id"), amountFen, payerRef: requiredText(row, commercialOperationsMethods.receiptReturnList, "payerRef", "payerRef", "payer_ref"), status: requiredText(row, commercialOperationsMethods.receiptReturnList, "status", "status"), requestedByActorId: requiredText(row, commercialOperationsMethods.receiptReturnList, "requestedByActorId", "requestedByActorId", "requested_by_actor_id"), approvedByActorId: optionalText(pick(row,"approvedByActorId","approved_by_actor_id")), externalReturnId: optionalText(pick(row,"externalReturnId","external_return_id")) };
  });
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

export interface CommercialRefundEvent {
  id: string;
  workspaceId: string;
  orderId: string;
  requestId: string;
  revision: number;
  eventType: string;
  refundKind: CommercialRefundKind;
  amountFen: number;
  pointsToRevoke: number;
  reason: string;
  actorId: string;
  evidence: RecordValue;
  externalRefundId: string | null;
  createdAt: string;
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

export interface CommercialPage<T> {
  items: T[]
  total: number
  truncated?: boolean
  nextCursor?: string | null
}

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
  return { ...pageMeta(page), items: page.rows.map((row) => ({
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
  return { ...pageMeta(page), items: page.rows.map((row) => ({
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
    sourceOrderStatus: optionalText(pick(row, "source_order_status", "sourceOrderStatus")),
    updatedAt: optionalText(pick(row, "updated_at", "updatedAt")),
  })) };
}

export function parseLedger(value: unknown): CommercialPage<CreativePointLedgerEntry> {
  const method = commercialOperationsMethods.ledger;
  const page = pageRows(value, method);
  return { ...pageMeta(page), items: page.rows.map((row) => {
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
  return { ...pageMeta(page), items: page.rows.map((row) => ({
    id: requiredText(row, method, "id", "id", "sku_id"), skuCode: requiredText(row, method, "sku_code", "sku_code", "skuCode", "code"),
    name: requiredText(row, method, "name", "name"), type: requiredText(row, method, "type", "type", "sku_type"),
    visibility: requiredText(row, method, "visibility", "visibility"), version: requiredText(row, method, "version", "version", "sku_version"),
    priceLabel: requiredText(row, method, "price_label", "price_label", "priceLabel"), priceFen: finiteNumber(pick(row, "price_fen", "priceFen")), cycleLabel: optionalText(pick(row, "cycle_label", "cycleLabel")), durationDays: finiteNumber(pick(row, "duration_days", "durationDays")), priceMode: optionalText(pick(row, "price_mode", "priceMode")),
    benefitsSummary: requiredText(row, method, "benefits_summary", "benefits_summary", "benefitsSummary"),
    benefits: Array.isArray(row.benefits) ? row.benefits.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      return typeof item.code === "string" && item.code.trim() ? [{ code: item.code, quantity: typeof item.quantity === "number" && Number.isSafeInteger(item.quantity) ? item.quantity : null, rawValue: typeof item.raw_value === "string" ? item.raw_value : null, rawUnit: typeof item.raw_unit === "string" ? item.raw_unit : null, normalizedValue: finiteNumber(item.normalized_value), policyRef: optionalText(item.policy_ref), metadata: object(item.metadata) ? item.metadata : {} }] : [];
    }) : [],
    approvalState: requiredText(row, method, "approval_state", "approval_state", "approvalState", "status"),
    executable: boolean(row.executable) ?? false,
    currentSaleState: optionalText(pick(row, "current_sale_state", "sale_state", "currentSaleState")),
    currentSaleVersionId: optionalText(pick(row, "current_sale_version_id", "current_version_id", "currentSaleVersionId")),
    // Revision zero is the valid initial state for a newly created SKU; keep it
    // distinct from a missing projection because catalog actions require CAS.
    saleRevision: finiteNumber(pick(row, "sale_revision", "saleRevision", "catalog_sale_revision")),
    payload: object(row.payload) ? row.payload : { ...(object(row.cycle) ? { cycle: row.cycle } : {}), ...(text(row.family) ? { planFamily: row.family } : {}), ...(finiteNumber(row.tier_rank) !== null ? { tierRank: finiteNumber(row.tier_rank) } : {}), ...(Array.isArray(row.bundle_refs) ? { bundleRefs: row.bundle_refs } : {}) },
    validFrom: optionalText(pick(row, "valid_from", "validFrom")), validTo: optionalText(pick(row, "valid_to", "validTo")),
    unresolved: stringArray(row.unresolved),
  })) };
}

/**
 * Package choices used when an operator provisions a merchant account must
 * come from the versioned server catalog. In particular, a label or a legacy
 * SKU alias is not enough to grant a commercial entitlement.
 */
export function provisionableCatalogItems(items: readonly CommercialCatalogItem[]): CommercialCatalogItem[] {
  return items
    .filter((item) => item.visibility === "public" && item.currentSaleState === "on_sale" && item.currentSaleVersionId === item.id && item.approvalState === "approved" && item.executable === true && item.unresolved.length === 0 && item.priceFen !== null && item.priceFen !== undefined)
    .slice()
    .sort((left, right) => left.skuCode.localeCompare(right.skuCode) || left.version.localeCompare(right.version));
}

export function parseOrders(value: unknown): CommercialPage<CommercialOrderItem> {
  const method = commercialOperationsMethods.orders;
  const page = pageRows(value, method);
  return { ...pageMeta(page), items: page.rows.map((row) => ({
    id: requiredText(row, method, "id", "id", "order_id"), workspaceId: requiredText(row, method, "workspace_id", "workspace_id", "workspaceId"),
    skuCode: requiredText(row, method, "sku_code", "sku_code", "skuCode"), skuVersion: requiredText(row, method, "sku_version", "sku_version", "skuVersion"),
    purchasedPoints: finiteNumber(pick(row, "purchased_points", "purchasedPoints")), amountLabel: requiredText(row, method, "amount_label", "amount_label", "amountLabel"),
    channel: optionalText(row.channel), paymentState: requiredText(row, method, "payment_state", "payment_state", "paymentState"),
    grantState: requiredText(row, method, "grant_state", "grant_state", "grantState"), accessRevision: optionalText(pick(row, "access_revision", "accessRevision")),
    createdAt: requiredText(row, method, "created_at", "created_at", "createdAt"), paidAt: optionalText(pick(row, "paid_at", "paidAt")),
    requestId: optionalText(pick(row, "request_id", "requestId")),
  })) };
}

export function parseCommercialRefunds(value: unknown): CommercialPage<CommercialRefundEvent> {
  const method = commercialOperationsMethods.refundList;
  const page = pageRows(value, method);
  const kinds: CommercialRefundKind[] = ["onboarding_pre_deployment", "monthly_unused_points", "point_pack_unused_points", "outage_compensation", "custom_milestone"];
  return { ...pageMeta(page), items: page.rows.map((row) => {
    const revision = finiteNumber(row.revision);
    const amountFen = finiteNumber(pick(row, "amount_fen", "amountFen"));
    const pointsToRevoke = finiteNumber(pick(row, "points_to_revoke", "pointsToRevoke"));
    const refundKind = pick(row, "refund_kind", "refundKind");
    if (revision === null || !Number.isSafeInteger(revision) || revision < 1) invalid(method, "revision 缺失");
    if (amountFen === null || !Number.isSafeInteger(amountFen) || amountFen < 1) invalid(method, "amount_fen 缺失");
    if (pointsToRevoke === null || !Number.isSafeInteger(pointsToRevoke) || pointsToRevoke < 0) invalid(method, "points_to_revoke 缺失");
    if (typeof refundKind !== "string" || !kinds.includes(refundKind as CommercialRefundKind)) invalid(method, "refund_kind 无效");
    return {
      id: requiredText(row, method, "id", "id"), workspaceId: requiredText(row, method, "workspace_id", "workspace_id", "workspaceId"),
      orderId: requiredText(row, method, "order_id", "order_id", "orderId"), requestId: requiredText(row, method, "request_id", "request_id", "requestId"),
      revision, eventType: requiredText(row, method, "event_type", "event_type", "eventType"), refundKind: refundKind as CommercialRefundKind,
      amountFen, pointsToRevoke, reason: requiredText(row, method, "reason", "reason"), actorId: requiredText(row, method, "actor_id", "actor_id", "actorId"),
      evidence: object(row.evidence) ? row.evidence : {}, externalRefundId: optionalText(pick(row, "external_refund_id", "externalRefundId")),
      createdAt: requiredText(row, method, "created_at", "created_at", "createdAt"),
    };
  }) };
}

export function parseRates(value: unknown): CommercialPage<CreativePointRateItem> {
  const method = commercialOperationsMethods.rates;
  const page = pageRows(value, method);
  return { ...pageMeta(page), items: page.rows.map((row) => ({
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
  return { ...pageMeta(page), items: page.rows.map((row) => ({
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
  return { ...pageMeta(page), items: page.rows.map((row) => ({
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
  blocks: async (targetWorkspaceId: string, input?: CommercialPageInput, signal?: AbortSignal) => { const page = pageRequest(input, signal); return parseAccessBlocks(await rpc(commercialOperationsMethods.accessBlocks, { target_workspace_id: targetWorkspaceId, status: "open", ...page.params }, { signal: page.signal })); },
  entitlements: async (targetWorkspaceId: string, input?: CommercialPageInput, signal?: AbortSignal) => { const page = pageRequest(input, signal); return parseEntitlements(await rpc(commercialOperationsMethods.entitlements, { target_workspace_id: targetWorkspaceId, ...page.params }, { signal: page.signal })); },
  ledger: async (targetWorkspaceId: string, signal?: AbortSignal) => parseLedger(await rpc(commercialOperationsMethods.ledger, { target_workspace_id: targetWorkspaceId, limit: "100" }, { signal })),
  catalog: async (_targetWorkspaceId: string, includePrivate: boolean, signal?: AbortSignal) => parseCatalog(await rpc(commercialOperationsMethods.catalog, { limit: "100", include_private: String(includePrivate) }, { signal })),
  catalogManagement: async (input: CommercialCatalogManagementInput = {}, signal?: AbortSignal) => {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("目录分页 limit 必须是 1 到 100 的整数");
    return parseCatalog(await rpc(commercialOperationsMethods.catalog, {
      include_private: "false",
      limit: String(limit),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.saleState ? { sale_state: input.saleState } : {}),
      ...(input.search?.trim() ? { search: input.search.trim() } : {}),
    }, { signal }));
  },
  mutateCatalog: (input: { action: "create" | "approve" | "publish" | "retire" | "archive" | "delete_draft" | "submit" | "reject"; code: string; versionId?: string; expectedRevision?: number; idempotencyKey?: string; kind?: string; visibility?: string; priceFen?: number | null; priceMode?: string; durationDays?: number | null; family?: string; tierRank?: number; cycle?: Record<string, unknown>; bundleRefs?: unknown[]; payload?: Record<string, unknown>; benefits?: unknown[]; reason: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.catalogMutate, { action: input.action, code: input.code, ...(input.versionId ? { version_id: input.versionId } : {}), ...(input.expectedRevision !== undefined ? { expected_revision: String(input.expectedRevision) } : {}), ...(input.kind ? { kind: input.kind } : {}), ...(input.visibility ? { visibility: input.visibility } : {}), ...(input.priceFen !== undefined && input.priceFen !== null ? { price_fen: String(input.priceFen) } : {}), ...(input.priceMode ? { price_mode: input.priceMode } : {}), ...(input.durationDays ? { duration_days: String(input.durationDays) } : {}), ...(input.family ? { family: input.family } : {}), ...(input.tierRank !== undefined ? { tier_rank: String(input.tierRank) } : {}), ...(input.cycle ? { cycle_json: JSON.stringify(input.cycle) } : {}), ...(input.bundleRefs ? { bundle_refs_json: JSON.stringify(input.bundleRefs) } : {}), ...(input.payload ? { payload_json: JSON.stringify(input.payload) } : {}), ...(input.benefits ? { benefits_json: JSON.stringify(input.benefits) } : {}), idempotency_key: input.idempotencyKey ?? operationId("catalog_mutation"), reason: input.reason, evidence_json: JSON.stringify({ source: "ops_console", action: input.action }) }, { signal }),
  benefitDefinitions: async (signal?: AbortSignal): Promise<Record<string, unknown>[]> => {
    const value = await rpc(commercialOperationsMethods.benefitDefinitions, {}, { signal });
    const rows = pageRows(value, commercialOperationsMethods.benefitDefinitions).rows;
    for (const row of rows) requiredText(row, commercialOperationsMethods.benefitDefinitions, "code", "code");
    return rows;
  },
  benefitBundles: async (input?: CommercialPageInput, signal?: AbortSignal) => { const page = pageRequest(input, signal); return parseBenefitBundles(await rpc(commercialOperationsMethods.benefitBundles, page.params, { signal: page.signal })); },
  mutateBenefitBundle: (input: { action: CommercialCatalogAction; code: string; versionId?: string; expectedRevision: number; idempotencyKey: string; name?: string; usage?: "included" | "standalone"; payload?: Record<string, unknown>; benefits?: unknown[]; reason: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.benefitBundleMutate, {
    action: input.action, code: input.code, expected_revision: String(input.expectedRevision), idempotency_key: input.idempotencyKey, reason: input.reason,
    ...(input.versionId ? { version_id: input.versionId } : {}), ...(input.name ? { name: input.name } : {}), ...(input.usage ? { usage: input.usage } : {}), ...(input.payload ? { payload_json: JSON.stringify(input.payload) } : {}), ...(input.benefits ? { benefits_json: JSON.stringify(input.benefits) } : {}), evidence_json: JSON.stringify({ source: "ops_console", action: input.action }),
  }, { signal }),
  benefitBundleReferences: async (code: string, versionId?: string, signal?: AbortSignal) => pageRows(await rpc(commercialOperationsMethods.benefitBundleReferences, { code, ...(versionId ? { version_id: versionId } : {}) }, { signal }), commercialOperationsMethods.benefitBundleReferences).rows,
  orders: async (targetWorkspaceId: string, input?: CommercialPageInput, signal?: AbortSignal) => { const page = pageRequest(input, signal); return parseOrders(await rpc(commercialOperationsMethods.orders, { target_workspace_id: targetWorkspaceId, ...page.params }, { signal: page.signal })); },
  rates: async (_targetWorkspaceId: string, signal?: AbortSignal) => parseRates(await rpc(commercialOperationsMethods.rates, { limit: "100" }, { signal })),
  services: async (targetWorkspaceId: string, signal?: AbortSignal) => parseServices(await rpc(commercialOperationsMethods.services, { target_workspace_id: targetWorkspaceId, limit: "100" }, { signal })),
  timeline: async (targetWorkspaceId: string, inputOrSignal?: { from?: string; to?: string; status?: string } | AbortSignal, signal?: AbortSignal) => {
    const isSignal = typeof AbortSignal !== "undefined" && inputOrSignal instanceof AbortSignal;
    const input = isSignal ? {} : (inputOrSignal as { from?: string; to?: string; status?: string } | undefined ?? {});
    const requestSignal = isSignal ? inputOrSignal : signal;
    return parseCommercialTimeline(await rpc(commercialOperationsMethods.timeline, { target_workspace_id: targetWorkspaceId, limit: "200", ...(input.from ? { from_at: input.from } : {}), ...(input.to ? { to_at: input.to } : {}), ...(input.status ? { status: input.status } : {}) }, { signal: requestSignal }));
  },
  readiness: async (signal?: AbortSignal) => parseCommercialReadiness(await rpc(commercialOperationsMethods.readiness, {}, { signal })),
  createPrivateTrialInvite: (workspace: string, customerRef: string, expiresAt: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialInviteCreate, { target_workspace_id: workspace, customer_ref: customerRef, expires_at: expiresAt, idempotency_key: operationId("private_trial_invite"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "invite_create" }) }, { signal }),
  createPrivateTrialEligibility: (workspace: string, customerRef: string, inviteCode: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialEligibilityCreate, { target_workspace_id: workspace, customer_ref: customerRef, invite_code: inviteCode, idempotency_key: operationId("private_trial_eligibility"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "create", invite_code_present: true }) }, { signal }),
  createPrivateTrialOrder: (workspace: string, eligibilityId: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialOrderCreate, { target_workspace_id: workspace, eligibility_id: eligibilityId, idempotency_key: operationId("private_trial_order"), reason }, { signal }),
  verifyPrivateTrialPayment: (workspace: string, orderId: string, paymentSubjectRef: string, providerEventId: string, providerOrderId: string, nonce: string, payloadHash: string, paidAt: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialTrialPaymentVerify, { target_workspace_id: workspace, order_id: orderId, payment_subject_ref: paymentSubjectRef, provider_event_id: providerEventId, provider_order_id: providerOrderId, nonce, payload_hash: payloadHash, paid_at: paidAt, idempotency_key: operationId("private_trial_payment_verify"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "private_trial_payment_verified" }) }, { signal }),
  approvePrivateTrialEligibility: (workspace: string, eligibilityId: string, expectedRevision: number, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialEligibilityApprove, { target_workspace_id: workspace, eligibility_id: eligibilityId, expected_revision: String(expectedRevision), idempotency_key: operationId("private_trial_approve"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "business_approve" }) }, { signal }),
  completePrivateTrialValidation: (workspace: string, eligibilityId: string, trialOrderId: string, completedAt: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialValidationComplete, { target_workspace_id: workspace, eligibility_id: eligibilityId, trial_order_id: trialOrderId, completed_at: completedAt, idempotency_key: operationId("private_trial_validation"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "validation_complete" }) }, { signal }),
  preparePrivateTrialCredit: (workspace: string, eligibilityId: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialCreditPrepare, { target_workspace_id: workspace, eligibility_id: eligibilityId, idempotency_key: operationId("private_trial_credit_prepare"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "prepare_credit" }) }, { signal }),
  approvePrivateTrialCredit: (workspace: string, creditId: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialCreditApprove, { target_workspace_id: workspace, credit_id: creditId, idempotency_key: operationId("private_trial_credit_approve"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "accounting_approve" }) }, { signal }),
  createPrivateTrialConversionOrder: (workspace: string, creditId: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialConversionCreate, { target_workspace_id: workspace, credit_id: creditId, idempotency_key: operationId("private_trial_conversion"), reason }, { signal }),
  verifyPrivateTrialTransfer: (workspace: string, creditId: string, orderId: string, paymentSubjectRef: string, providerEventId: string, providerOrderId: string, nonce: string, payloadHash: string, paidAt: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.privateTrialPaymentVerify, { target_workspace_id: workspace, credit_id: creditId, order_id: orderId, payment_subject_ref: paymentSubjectRef, provider_event_id: providerEventId, provider_order_id: providerOrderId, nonce, payload_hash: payloadHash, paid_at: paidAt, idempotency_key: operationId("private_trial_transfer_verify"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "manual_transfer_verified" }) }, { signal }),
  verifyCommercialOrderTransfer: (workspace: string, orderId: string, paymentSubjectRef: string, providerEventId: string, providerOrderId: string, nonce: string, payloadHash: string, paidAt: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.orderPaymentVerify, { target_workspace_id: workspace, order_id: orderId, payment_subject_ref: paymentSubjectRef, provider_event_id: providerEventId, provider_order_id: providerOrderId, nonce, payload_hash: payloadHash, paid_at: paidAt, idempotency_key: operationId("commercial_order_transfer_verify"), reason, evidence_json: JSON.stringify({ source: "ops_console", action: "commercial_order_manual_transfer_verified" }) }, { signal }),
  searchPurchaseCustomers: async (query: string, signal?: AbortSignal) => {
      const method = "ops.users.list";
    const rows = pageRows(await rpc(method, { query: query.trim(), account_type: "merchant", limit: "50", offset: "0" }, { signal }), method).rows;
    return rows.map(row => ({ workspaceId: requiredText(row,method,"workspaceId","workspaceId","workspace_id"), memberId: requiredText(row,method,"memberId","memberId","member_id"), customerId: requiredText(row,method,"externalSubject","externalSubject","external_subject"), name: requiredText(row,method,"displayName","displayName","display_name"), enterpriseName: optionalText(pick(row,"enterpriseName","enterprise_name")), workspaceStatus: optionalText(pick(row,"workspaceStatus","workspace_status")), status: requiredText(row,method,"status","status") }));
  },
  createAssistedUpgradeQuote: (workspace: string, skuCode: string, idempotencyKey: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.assistedUpgradeQuoteCreate, { target_workspace_id: workspace, target_sku_code: skuCode, idempotency_key: idempotencyKey }, { signal }).then(parseAssistedUpgradeQuote),
  getAssistedUpgradeQuote: (workspace: string, quoteId: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.assistedUpgradeQuoteGet, { target_workspace_id: workspace, upgrade_quote_id: quoteId }, { signal }),
  previewAssistedOrder: (input: AssistedOrderInput, signal?: AbortSignal) => rpc(commercialOperationsMethods.assistedOrderPreview, assistedOrderParams(input), { signal }).then(parseAssistedOrderPreview),
  createAssistedOrder: (input: AssistedOrderInput & { previewHash: string; idempotencyKey: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.assistedOrderCreate, { ...assistedOrderParams(input), preview_hash: input.previewHash, idempotency_key: input.idempotencyKey }, { signal }),
  getAssistedOrderRequest: (workspace: string, key: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.assistedOrderRequest, { target_workspace_id: workspace, idempotency_key: key }, { signal }),
  getAssistedQuoteRequest: (workspace: string, key: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.assistedQuoteRequest, { target_workspace_id: workspace, idempotency_key: key }, { signal }),
  getAssistedCheckoutRequest: (workspace: string, key: string, signal?: AbortSignal) => rpc("ops.commercial.checkout.request.get", { target_workspace_id:workspace,idempotency_key:key }, { signal }),
  previewAssistedCheckout: (input: { workspace: string; beneficiaryMemberId: string; onboardingSkuCode: string; subscriptionSkuCode: string; reason: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.assistedCheckoutPreview, { target_workspace_id: input.workspace, beneficiary_member_id: input.beneficiaryMemberId, onboarding_sku_code: input.onboardingSkuCode, subscription_sku_code: input.subscriptionSkuCode, reason: input.reason }, { signal }).then(parseAssistedCheckoutPreview),
  createAssistedCheckout: (input: { workspace: string; beneficiaryMemberId: string; onboardingSkuCode: string; subscriptionSkuCode: string; reason: string; previewHash: string; idempotencyKey: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.assistedCheckoutCreate, { target_workspace_id: input.workspace, beneficiary_member_id: input.beneficiaryMemberId, onboarding_sku_code: input.onboardingSkuCode, subscription_sku_code: input.subscriptionSkuCode, reason: input.reason, preview_hash: input.previewHash, idempotency_key: input.idempotencyKey }, { signal }),
  getReceiptRequest: async (input: { workspace?: string; receivingAccountRef: string; externalTradeId: string }, signal?: AbortSignal) => {
    const value: unknown = await rpc("ops.commercial.receipt.request.get", { source:"bank_transfer", receiving_account_ref:input.receivingAccountRef, external_trade_id:input.externalTradeId, ...(input.workspace ? {target_workspace_id:input.workspace}: {}) }, {signal});
    if(value === null)return null;
    if(!object(value) || !object(value.receipt))invalid("ops.commercial.receipt.request.get","原到账事实缺失");
    return parseReceiptFact(value,pick(value.receipt,"workspaceId","workspace_id") === null ? "unmatched" : "matched");
  },
  getReceiptAllocationRequest: (workspace: string, key: string, signal?: AbortSignal) => rpc("ops.commercial.receipt.allocation.request.get",{target_workspace_id:workspace,idempotency_key:key},{signal}),
  getReceiptReturnRequest: async (returnId: string, workspace?: string, signal?: AbortSignal) => {
    const value: unknown = await rpc("ops.commercial.receipt.return.request.get",{return_id:returnId,...(workspace?{target_workspace_id:workspace}:{})},{signal});
    if(value === null)return null;
    if(!object(value) || !object(value.item))invalid("ops.commercial.receipt.return.request.get","原返款事实缺失");
    return parseCommercialReturns({items:[value.item]})[0]!;
  },
  listCashReturnPage: async (workspace?: string, input?: CommercialPageInput, signal?: AbortSignal): Promise<CommercialPage<CommercialCashReturn>> => {
    const page=pageRequest(input,signal);const method=workspace?commercialOperationsMethods.receiptReturnList:"ops.commercial.receipt.unmatched.return.list";
    const value=await rpc(method,{...page.params,...(workspace?{target_workspace_id:workspace}:{})},{signal:page.signal});const rows=pageRows(value,method);
    return {...pageMeta(rows),items:parseCommercialReturns(value)};
  },
  proposeUnmatchedReturn: (input: {receiptId:string;returnId:string;amountFen:number;payerRef:string;expectedRevision:number;evidenceRef:string;reason:string},signal?:AbortSignal) => rpc("ops.commercial.receipt.unmatched.return.propose",{receipt_id:input.receiptId,return_id:input.returnId,amount_fen:String(input.amountFen),payer_ref:input.payerRef,expected_revision:String(input.expectedRevision),reason:input.reason,evidence_json:JSON.stringify({evidence_ref:input.evidenceRef})},{signal}),
  decideUnmatchedReturn: (input:{returnId:string;action:"approve"|"reject";evidenceRef:string},signal?:AbortSignal) => rpc("ops.commercial.receipt.unmatched.return.decide",{return_id:input.returnId,decision:input.action,evidence_json:JSON.stringify({evidence_ref:input.evidenceRef})},{signal}),
  completeUnmatchedReturn: (input:{returnId:string;outcome:"completed"|"unknown";externalReturnId?:string;evidenceRef:string},signal?:AbortSignal) => rpc("ops.commercial.receipt.unmatched.return.complete",{return_id:input.returnId,outcome:input.outcome,...(input.externalReturnId?{external_return_id:input.externalReturnId}:{}),evidence_json:JSON.stringify({evidence_ref:input.evidenceRef})},{signal}),
  listUnmatchedReceipts: async (input?: CommercialPageInput, signal?: AbortSignal) => { const page = pageRequest(input,signal); return parseUnmatchedReceiptPage(await rpc(commercialOperationsMethods.unmatchedReceiptList,page.params,{signal:page.signal})); },
  recordUnmatchedReceipt: (input: UnmatchedReceiptRecordInput, signal?: AbortSignal) => rpc(commercialOperationsMethods.unmatchedReceiptRecord,{source:"bank_transfer",receiving_account_ref:input.receivingAccountRef,external_trade_id:input.externalTradeId,payer_ref:input.payerRef,amount_fen:String(input.amountFen),currency:"CNY",received_at:input.receivedAt,reason:input.reason,evidence_json:JSON.stringify({evidence_ref:input.evidenceRef})},{signal}).then(parseUnmatchedCashReceipt),
  matchUnmatchedReceipt: (input: { workspace: string; receiptId: string; customerRef: string; reason: string; evidenceRef: string },signal?:AbortSignal) => rpc(commercialOperationsMethods.unmatchedReceiptMatch,{receipt_id:input.receiptId,target_workspace_id:input.workspace,reason:input.reason,evidence_json:JSON.stringify({ownership_evidence_ref:input.evidenceRef,matched_customer_ref:input.customerRef})},{signal}).then(parseCommercialReceipt),
  listReceipts: async (workspace: string, signal?: AbortSignal) => pageRows(await rpc(commercialOperationsMethods.receiptList, { target_workspace_id: workspace, limit: "100" }, { signal }), commercialOperationsMethods.receiptList).rows.map(parseCommercialReceipt),
  getReceipt: async (workspace: string, receiptId: string, signal?: AbortSignal) => parseCommercialReceipt(await rpc(commercialOperationsMethods.receiptGet, { target_workspace_id: workspace, receipt_id: receiptId }, { signal })),
  recordReceipt: async (input: { workspace: string; source: string; receivingAccountRef: string; externalTradeId: string; payerRef: string; amountFen: number; receivedAt: string; evidenceRef: string; idempotencyKey: string; reason: string }, signal?: AbortSignal) => parseCommercialReceipt(await rpc(commercialOperationsMethods.receiptRecord, { target_workspace_id: input.workspace, source: input.source, receiving_account_ref: input.receivingAccountRef, external_trade_id: input.externalTradeId, payer_ref: input.payerRef, amount_fen: String(input.amountFen), currency: "CNY", received_at: input.receivedAt, evidence_json: JSON.stringify({ evidence_ref: input.evidenceRef }), idempotency_key: input.idempotencyKey, reason: input.reason }, { signal })),
  previewReceiptAllocation: async (input: { workspace: string; receiptId: string; orderId: string; amountFen: number; expectedRevision: number }, signal?: AbortSignal) => parseAllocationPreview(await rpc(commercialOperationsMethods.allocationPreview, { target_workspace_id: input.workspace, receipt_id: input.receiptId, order_id: input.orderId, amount_fen: String(input.amountFen), expected_revision: String(input.expectedRevision) }, { signal })),
  previewReceiptAllocationBatch: (workspace: string, allocations: CashAllocationLine[], signal?: AbortSignal) => rpc("ops.commercial.receipt.allocations.preview", { target_workspace_id: workspace, allocations_json: JSON.stringify(allocations) }, { signal }).then(parseAllocationBatchPreview),
  confirmReceiptAllocationBatch: (input: { workspace: string; allocations: CashAllocationLine[]; previewHash: string; idempotencyKey: string }, signal?: AbortSignal) => rpc("ops.commercial.receipt.allocations.confirm", { target_workspace_id: input.workspace, allocations_json: JSON.stringify(input.allocations), preview_hash: input.previewHash, idempotency_key: input.idempotencyKey }, { signal }),
  confirmReceiptAllocation: (input: { workspace: string; receiptId: string; orderId: string; amountFen: number; expectedRevision: number; previewHash: string; idempotencyKey: string; reason: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.allocationConfirm, { target_workspace_id: input.workspace, receipt_id: input.receiptId, order_id: input.orderId, amount_fen: String(input.amountFen), expected_revision: String(input.expectedRevision), preview_hash: input.previewHash, idempotency_key: input.idempotencyKey, reason: input.reason }, { signal }),
  listReceiptReturns: async (workspace: string, signal?: AbortSignal) => parseCommercialReturns(await rpc(commercialOperationsMethods.receiptReturnList, { target_workspace_id: workspace, limit: "100" }, { signal })),
  proposeReceiptReturn: (input: { workspace: string; receiptId: string; returnId: string; amountFen: number; payerRef: string; expectedRevision: number; evidenceRef: string; reason: string; idempotencyKey: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.receiptReturnPropose, { target_workspace_id: input.workspace, receipt_id: input.receiptId, return_id: input.returnId, amount_fen: String(input.amountFen), payer_ref: input.payerRef, expected_revision: String(input.expectedRevision), reason: input.reason, idempotency_key: input.idempotencyKey, evidence_json: JSON.stringify({ evidence_ref: input.evidenceRef }) }, { signal }),
  decideReceiptReturn: (input: { workspace: string; returnId: string; action: "approve" | "reject"; evidenceRef: string; reason: string; idempotencyKey: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.receiptReturnDecide, { target_workspace_id: input.workspace, return_id: input.returnId, decision: input.action, reason: input.reason, idempotency_key: input.idempotencyKey, evidence_json: JSON.stringify({ evidence_ref: input.evidenceRef }) }, { signal }),
  completeReceiptReturn: (input: { workspace: string; returnId: string; outcome: "completed" | "unknown"; externalReturnId?: string; evidenceRef: string; reason: string; idempotencyKey: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.receiptReturnComplete, { target_workspace_id: input.workspace, return_id: input.returnId, outcome: input.outcome, ...(input.externalReturnId ? { external_return_id: input.externalReturnId } : {}), reason: input.reason, idempotency_key: input.idempotencyKey, evidence_json: JSON.stringify({ evidence_ref: input.evidenceRef }) }, { signal }),
  listCommercialRefunds: async (workspace: string, signal?: AbortSignal) => parseCommercialRefunds(await rpc(commercialOperationsMethods.refundList, { target_workspace_id: workspace, limit: "100" }, { signal })),
  requestCommercialRefund: async (input: { workspace: string; orderId: string; requestId: string; kind: CommercialRefundKind; amountFen: number; pointsToRevoke: number; reason: string; evidenceRef: string }, signal?: AbortSignal) => rpc(commercialOperationsMethods.refundRequest, { target_workspace_id: input.workspace, order_id: input.orderId, request_id: input.requestId, refund_kind: input.kind, amount_fen: String(input.amountFen), points_to_revoke: String(input.pointsToRevoke), reason: input.reason, evidence_json: JSON.stringify(commercialRefundEvidence(input.kind, input.evidenceRef)) }, { signal, idempotencyKey: await refundOperationKey("request", input.workspace, input.requestId) }),
  approveCommercialRefund: async (workspace: string, requestId: string, policyApproval: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.refundApprove, { target_workspace_id: workspace, request_id: requestId, reason, policy_approval_json: JSON.stringify(refundPolicyApproval(policyApproval)) }, { signal, idempotencyKey: await refundOperationKey("approve", workspace, requestId) }),
  completeCommercialRefund: async (workspace: string, requestId: string, externalRefundId: string, evidenceJson: string, reason: string, signal?: AbortSignal) => rpc(commercialOperationsMethods.refundComplete, { target_workspace_id: workspace, request_id: requestId, external_refund_id: externalRefundId, reason, evidence_json: evidenceJson }, { signal, idempotencyKey: await refundOperationKey("complete", workspace, requestId) }),
  proposePointAdjustment: async (targetWorkspaceId: string, pointsDelta: number, reason: string, signal?: AbortSignal) => rpc("ops.commercial.points.adjust.propose", { target_workspace_id: targetWorkspaceId, points_delta: String(pointsDelta), expected_revision: "0", idempotency_key: operationId("point_adjust_propose"), reason, evidence_json: JSON.stringify({ source: "ops_console", mode: "test" }) }, { signal }),
  decidePointAdjustment: async (targetWorkspaceId: string, proposalId: string, decision: "approved" | "rejected", reason: string, signal?: AbortSignal) => rpc("ops.commercial.points.adjust.decide", { target_workspace_id: targetWorkspaceId, proposal_id: proposalId, decision, idempotency_key: operationId("point_adjust_decide"), reason, evidence_json: JSON.stringify({ source: "ops_console", mode: "test" }) }, { signal }),
  scheduleService: (workspace: string, allocation: string, revision: number, scheduleAt: string, reason: string, approvalToken?: string) => serviceCommand("ops.commercial.service-fulfillment.schedule", workspace, allocation, revision, reason, { schedule_at: scheduleAt }, approvalToken),
  startService: (workspace: string, allocation: string, revision: number, reason: string, approvalToken?: string) => serviceCommand("ops.commercial.service-fulfillment.start", workspace, allocation, revision, reason, {}, approvalToken),
  completeService: (workspace: string, allocation: string, revision: number, quantity: number, reason: string, approvalToken?: string) => serviceCommand("ops.commercial.service-fulfillment.complete", workspace, allocation, revision, reason, { actual_quantity: String(quantity) }, approvalToken),
  adjustService: (workspace: string, allocation: string, revision: number, eventId: string, quantity: number, reason: string, approvalToken?: string) => serviceCommand("ops.commercial.service-fulfillment.adjust", workspace, allocation, revision, reason, { corrects_event_id: eventId, actual_quantity: String(quantity) }, approvalToken),
  createServiceAllocation,
};

export type CommercialOperationsClient = typeof commercialOperationsClient;

/** Only identifiers and numeric original facts persist; evidence and credentials never persist. */
export type CashRecoveryIntent = {key:string} & (
  | {kind:"record";workspace?:string;receivingAccountRef:string;externalTradeId:string;amountFen:number;payerRef:string;receivedAt:string}
  | {kind:"match";workspace:string;receiptId:string;receivingAccountRef:string;externalTradeId:string;amountFen:number;payerRef:string}
  | {kind:"allocation";workspace:string;lines:CashAllocationLine[];batch:boolean}
  | {kind:"return";workspace?:string;returnId:string;receiptId:string;amountFen:number;payerRef:string;action:"propose"|"approve"|"reject"|"completed"|"unknown";externalReturnId?:string}
);
export async function recoverCashIntent(client:CommercialOperationsClient,intent:CashRecoveryIntent):Promise<boolean> {
  if(intent.kind === "record" || intent.kind === "match") {
    const fact=intent.kind === "match"?await client.getReceipt(intent.workspace,intent.receiptId):await client.getReceiptRequest(intent);
    return !!fact && fact.source==="bank_transfer" && (intent.kind!=="record" || Date.parse(fact.receivedAt)===Date.parse(intent.receivedAt)) && fact.receivingAccountRef===intent.receivingAccountRef && fact.externalTradeId===intent.externalTradeId && fact.amountFen===intent.amountFen && fact.payerRef===intent.payerRef && (intent.kind!=="match" || fact.id===intent.receiptId) && (!intent.workspace || fact.workspaceId===intent.workspace);
  }
  if(intent.kind === "allocation") {
    if(!intent.lines.length || intent.lines.length>100)return false;
    const facts=await Promise.all(intent.lines.map((_,index)=>client.getReceiptAllocationRequest(intent.workspace,intent.batch?`${intent.key}:${index}`:intent.key)));
    return facts.every((raw,index)=>{const value:unknown=raw;const original=intent.lines[index]!;if(!object(value)||!object(value.allocation))return false;const fact=value.allocation;return fact.receiptId===original.receipt_id && fact.orderId===original.order_id && fact.allocatedFen===original.amount_fen && typeof fact.allocationId==="string" && !!fact.allocationId && ["partially_received","fully_received"].includes(String(fact.status));});
  }
  let item:CommercialCashReturn|undefined|null;
  if(intent.action === "propose")item=await client.getReceiptReturnRequest(intent.returnId,intent.workspace);
  else {let cursor:string|undefined;const seen=new Set<string>();for(let pageNumber=0;pageNumber<100;pageNumber++){const page=await client.listCashReturnPage(intent.workspace,{limit:100,...(cursor?{cursor}:{})});item=page.items.find(row=>row.id===intent.returnId);if(item||!page.nextCursor)break;if(seen.has(page.nextCursor))break;seen.add(page.nextCursor);cursor=page.nextCursor;}}
  if(!item || item.id!==intent.returnId || item.receiptId!==intent.receiptId || item.amountFen!==intent.amountFen || item.payerRef!==intent.payerRef)return false;
  if(intent.action === "propose")return true;
  if(intent.action === "approve")return ["approved","pending_external","external_unknown","completed"].includes(item.status) && !!item.approvedByActorId;
  if(intent.action === "reject")return item.status === "rejected";
  if(intent.action === "unknown")return item.status === "external_unknown" || item.status === "completed";
  return item.status === "completed" && !!intent.externalReturnId && item.externalReturnId === intent.externalReturnId;
}
