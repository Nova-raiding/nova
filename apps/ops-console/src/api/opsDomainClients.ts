import { financeRecordKinds, type FinanceExport, type FinanceRecordDetail, type FinanceSearchPage, type FinanceSearchQuery } from "../../../../packages/contracts/src/ops/finance-search.js";
import type { SupportDomainClient } from "../hooks/useSupportDomain.js";
import type { FinanceSearchClient } from "../hooks/useFinanceSearch.js";
import type { IncidentsClient } from "../hooks/useIncidents.js";
import type { AuditCenterClient, AuditCenterFilters } from "../hooks/useAuditCenter.js";
import { supportTicketEventTypes, supportTicketPriorities, supportTicketStatuses, type SupportTicketContract, type SupportTicketEventContract, type SupportTicketPageContract } from "../../../../packages/contracts/src/ops/support.js";
import type { SupportSlaCorrectionApprovalProgress, SupportSlaCorrectionDecision, SupportSlaCorrectionRun, SupportSlaMonthlyReport } from "../../../../packages/contracts/src/ops/support-sla-report.js";
import { incidentSeverities, incidentStatuses } from "../../../../packages/contracts/src/ops/incidents.js";
import { auditSources, type AuditCenterExport, type AuditCenterPage, type AuditCenterDetail, type AuditCenterQuery } from "../../../../packages/contracts/src/ops/audit-center.js";
import type { ModelStatus, StorageReconciliationSummary } from "../types/ops.js";
import { MAX_OPS_EXPORT_RESPONSE_BYTES, OPS_EXPORT_TIMEOUT_MS, rpc, rpcForWorkspace } from "./opsClient.js";

export class OpsDomainResponseError extends Error {
  readonly code = "OPS_INVALID_RESPONSE";
  constructor(domain: string, field: string) {
    super(`${domain} 返回了无效响应（${field}）`);
    this.name = "OpsDomainResponseError";
  }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const bool = (value: unknown): value is boolean => typeof value === "boolean";
const optionalText = (value: unknown) => value === undefined || text(value);
const optionalFinite = (value: unknown) => value === undefined || finite(value);
const scalar = (value: unknown) => value === null || typeof value === "string" || finite(value) || bool(value);
const fail = (domain: string, field: string): never => { throw new OpsDomainResponseError(domain, field); };
const textArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const nullableText = (value: unknown) => value === null || text(value);
const containsFixtureMarker = (value: unknown): boolean => typeof value === "string"
  ? /(?:fixture|demo|example\.test|localhost|local-only)/iu.test(value)
  : Array.isArray(value) ? value.some(containsFixtureMarker)
    : object(value) ? Object.values(value).some(containsFixtureMarker) : false;

const modelKinds = ["text", "image", "image_edit", "ocr", "video"] as const;
const modelStates = ["ready", "release_metadata_blocked", "model_relay_blocked", "cost_gate_blocked", "partial_model_readiness", "not_configured"] as const;
const modelGate = (value: unknown): boolean => object(value)
  && bool(value.ready) && bool(value.https) && textArray(value.reasons)
  && optionalText(value.endpointHost);

/** Validate the complete five-modality response before it can reach readiness UI. */
export const parseModelStatus = (value: unknown): ModelStatus => {
  if (!object(value)) fail("平台模型状态", "五模态/relay/成本/发布证据");
  const candidate = value as Record<string, unknown>;
  const relay = candidate.relay;
  const capabilities = candidate.capabilities;
  const readiness = candidate.model_readiness;
  const quotas = candidate.quotas;
  const costEvidence = candidate.cost_evidence_by_modality;
  const allModalitiesReady = object(readiness) && modelKinds.every(kind => {
    const modality = readiness[kind];
    return object(modality) && modality.ready === true;
  });
  const allModalitiesHaveCostEvidence = object(costEvidence) && modelKinds.every(kind => costEvidence[kind] === true);
  if (candidate.ownership !== "platform" || candidate.user_key_binding !== false
    || !modelStates.includes(candidate.state as never) || !nullableText(candidate.provider_host)
    || !nullableText(candidate.text_model) || !nullableText(candidate.image_model)
    || !nullableText(candidate.vision_model) || !nullableText(candidate.video_model)
    || !object(relay) || !bool(relay.configured) || !nullableText(relay.host) || !textArray(relay.reasons ?? [])
    || !object(capabilities) || !object(readiness) || modelKinds.some(kind => !modelGate(readiness[kind]))
    || !["text_generation", "image_generation", "image_editing", "image_fact_ocr", "video_rendering"].every(key => bool(capabilities[key]))
    || !object(quotas) || !["rpm", "tpm"].every(key => quotas[key] === null || finite(quotas[key]))
    || !(quotas.daily_cny_limit === null || typeof quotas.daily_cny_limit === "string")
    || !bool(candidate.cost_control_ready) || !bool(candidate.cost_evidence_ready)
    || !object(costEvidence) || modelKinds.some(kind => !bool(costEvidence[kind]))
    || !bool(candidate.release_metadata_ready) || !textArray(candidate.release_metadata_missing)
    || !textArray(candidate.next_actions)
    || (candidate.state === "ready" && (!relay.configured
      || !allModalitiesReady
      || candidate.cost_control_ready !== true
      || candidate.cost_evidence_ready !== true
      || !allModalitiesHaveCostEvidence
      || candidate.release_metadata_ready !== true))
    || containsFixtureMarker(candidate)) fail("平台模型状态", "五模态/relay/成本/发布证据");
  return value as unknown as ModelStatus;
};

const storageStatuses = ["clean", "attention_required", "failed", "unavailable"] as const;
const storageFreshness = ["fresh", "stale", "expired", "unknown"] as const;
const storageSummary = (value: unknown): value is StorageReconciliationSummary => {
  if (!object(value)) return false;
  const candidate = value;
  const quota = candidate.quota;
  const counts = candidate.counts;
  if (!storageStatuses.includes(candidate.status as never) || (candidate.runStatus !== undefined && !["succeeded", "failed"].includes(String(candidate.runStatus))) || (candidate.freshness !== undefined && !storageFreshness.includes(candidate.freshness as never))) return false;
  if (candidate.workspaceId !== undefined && !text(candidate.workspaceId)) return false;
  if (candidate.workspace_id !== undefined && !text(candidate.workspace_id)) return false;
  if (candidate.lastRunAt !== undefined && candidate.lastRunAt !== null && !text(candidate.lastRunAt)) return false;
  if (quota !== undefined && (!object(quota) || ["usedBytes", "reservedBytes", "projectedBytes"].some(key => !finite(quota[key])) || (quota.limitBytes !== undefined && !finite(quota.limitBytes)))) return false;
  if (counts !== undefined && (!object(counts) || ["references", "inventoryObjects", "matched", "missing", "metadataMismatches", "orphans", "crossWorkspace", "duplicates"].some(key => !finite(counts[key])))) return false;
  return (candidate.message === undefined || typeof candidate.message === "string") && (candidate.errorMessage === undefined || typeof candidate.errorMessage === "string");
};

export const parseStorageReconciliationList = (value: unknown): StorageReconciliationSummary[] => {
  if (!Array.isArray(value) || !value.every(storageSummary)) fail("存储对账", "workspace 状态");
  return (value as unknown[]).map(item => {
    const candidate = item as unknown as Record<string, unknown>;
    return { ...candidate, workspaceId: candidate.workspaceId ?? candidate.workspace_id } as StorageReconciliationSummary;
  });
};

const incident = (value: unknown): value is import("../hooks/useIncidents.js").OpsIncident => object(value)
  && ["id", "workspaceId", "title", "summary", "createdBy", "createdAt", "updatedAt"].every(key => text(value[key]))
  && incidentSeverities.includes(value.severity as never) && incidentStatuses.includes(value.status as never)
  && textArray(value.affectedComponents) && textArray(value.affectedWorkspaceIds)
  && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1
  && optionalText(value.commanderId) && optionalText(value.resolvedAt);
const timelineEntry = (value: unknown): value is import("../hooks/useIncidents.js").IncidentTimelineEntry => object(value)
  && ["id", "workspaceId", "incidentId", "body", "actorId", "createdAt"].every(key => text(value[key]))
  && ["created", "comment", "status_changed", "commander_changed", "scope_changed"].includes(String(value.kind))
  && Number.isSafeInteger(value.incidentRevision) && Number(value.incidentRevision) >= 1
  && (value.fromStatus === undefined || incidentStatuses.includes(value.fromStatus as never))
  && (value.toStatus === undefined || incidentStatuses.includes(value.toStatus as never));
const incidentPage = <T>(value: unknown, row: (candidate: unknown) => candidate is T, domain: string): { items: T[]; nextCursor?: string } => {
  if (!object(value) || !Array.isArray(value.items) || !value.items.every(row) || !optionalText(value.nextCursor)) fail(domain, "items/pagination");
  return value as unknown as { items: T[]; nextCursor?: string };
};
export const parseIncidentPage = (value: unknown) => incidentPage(value, incident, "事故列表");
export const parseIncidentTimelinePage = (value: unknown) => incidentPage(value, timelineEntry, "事故时间线");
export const parseIncidentMutation = (value: unknown) => {
  if (!object(value) || !incident(value.incident) || !timelineEntry(value.event)) fail("事故变更", "incident/event");
  return value as unknown as import("../hooks/useIncidents.js").IncidentMutationResult;
};

const supportTicket = (value: unknown): value is SupportTicketContract => object(value)
  && ["id", "workspaceId", "ticketNumber", "subject", "description", "customerId", "customerName", "createdBy", "createdAt", "updatedAt"].every(key => text(value[key]))
  && supportTicketStatuses.includes(value.status as never) && supportTicketPriorities.includes(value.priority as never)
  && textArray(value.tags) && Number.isSafeInteger(value.revision)
  && (Number(value.revision) >= 1 || (value.aggregate === true && Number(value.revision) === 0 && Number.isSafeInteger(value.count) && Number(value.count) >= 1))
  && ["customerEmail", "assignedTo", "relatedOrderId", "relatedTaskId"].every(key => optionalText(value[key]));
const supportEvent = (value: unknown): value is SupportTicketEventContract => object(value)
  && ["id", "workspaceId", "ticketId", "actorId", "idempotencyKey", "createdAt"].every(key => text(value[key]))
  && supportTicketEventTypes.includes(value.eventType as never)
  && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 1 && object(value.payload);
export const parseSupportPage = (value: unknown): SupportTicketPageContract => {
  const cursor = object(value) ? value.nextCursor : undefined;
  if (!object(value) || !Array.isArray(value.items) || !value.items.every(supportTicket)
    || (cursor !== undefined && (!object(cursor) || !text(cursor.createdAt) || !text(cursor.id)))) fail("客服工单列表", "items/pagination");
  return value as unknown as SupportTicketPageContract;
};
export const parseSupportDetail = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  if (!object(value) || !supportTicket(value.ticket) || !Array.isArray(value.events) || !value.events.every(supportEvent)) fail("客服工单详情", "ticket/events");
  return value as unknown as { ticket: SupportTicketContract; events: SupportTicketEventContract[] };
};
export const parseSupportMutation = (value: unknown) => {
  if (!object(value) || !supportTicket(value.ticket) || !supportEvent(value.event) || !bool(value.replayed)) fail("客服工单变更", "ticket/event/replayed");
  return value as unknown as { ticket: SupportTicketContract; event: SupportTicketEventContract; replayed: boolean };
};
const supportSlaReport = (value: unknown): value is SupportSlaMonthlyReport => object(value)
  && ["reportId", "workspaceId", "periodStart", "periodEnd", "cutoffAt", "checksum"].every(key => text(value[key]))
  && ["denominator", "met", "failed", "excluded", "lateOrUnresolved"].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
  && Array.isArray(value.policyVersions) && value.policyVersions.every(item => Number.isSafeInteger(item))
  && textArray(value.calendarVersions)
  && Array.isArray(value.ticketResults)
  && value.ticketResults.every(item => object(item) && text(item.ticketId) && ["met", "failed", "excluded"].includes(String(item.outcome)) && optionalText(item.terminalAt) && optionalText(item.exclusion));
export const parseSupportSlaReport = (value: unknown): SupportSlaMonthlyReport => {
  if (!supportSlaReport(value)) fail("SLA 月报", "report");
  return value as SupportSlaMonthlyReport;
};
export const parseSupportSlaCorrection = (value: unknown): SupportSlaCorrectionRun | { status: "no_change"; originalReportId: string; checksum: string } => {
  if (!object(value)) fail("SLA correction", "response");
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "no_change" && text(candidate.original_report_id) && text(candidate.checksum)) return { status: "no_change", originalReportId: candidate.original_report_id, checksum: candidate.checksum };
  if (text(candidate.correctionId) && text(candidate.originalReportId) && text(candidate.workspaceId) && text(candidate.reason) && text(candidate.sourceChecksum) && text(candidate.correctedChecksum) && text(candidate.idempotencyKey) && candidate.status === "pending_review") return candidate as unknown as SupportSlaCorrectionRun;
  return fail("SLA correction", "response");
};
export const parseSupportSlaCorrectionDecision = (value: unknown): SupportSlaCorrectionDecision | SupportSlaCorrectionApprovalProgress => {
  if (!object(value)) fail("SLA correction 决策", "response");
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "pending_approval" && text(candidate.correctionId) && text(candidate.workspaceId) && candidate.requiredApprovals === 2 && Array.isArray(candidate.approvals)) return candidate as unknown as SupportSlaCorrectionApprovalProgress;
  if (text(candidate.decisionId) && text(candidate.correctionId) && text(candidate.workspaceId) && text(candidate.reason) && text(candidate.actorId) && text(candidate.idempotencyKey) && text(candidate.decidedAt) && ["approved", "rejected"].includes(String(candidate.decision))) return candidate as unknown as SupportSlaCorrectionDecision;
  return fail("SLA correction 决策", "response");
};

const financeRecord = (value: unknown, detail = false): boolean => {
  if (!object(value)) return false;
  const requiredText = ["id", "workspaceId", "status", "label", "occurredAt", "updatedAt", "version"];
  if (requiredText.some(key => !text(value[key]))) return false;
  if (!financeRecordKinds.includes(value.kind as never) || value.redacted !== true) return false;
  if (!optionalText(value.enterpriseName)) return false;
  if (!optionalText(value.reference) || !optionalFinite(value.amountCny) || !optionalFinite(value.providerCostCny) || !optionalFinite(value.customerChargeCny) || !optionalFinite(value.units)) return false;
  if (value.direction !== undefined && value.direction !== "credit" && value.direction !== "debit") return false;
  return !detail || (object(value.attributes) && Object.values(value.attributes).every(scalar));
};

export const parseFinanceSearchPage = (value: unknown): FinanceSearchPage => {
  if (!object(value)) fail("财务检索", "response");
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.records) || !candidate.records.every(record => financeRecord(record))) fail("财务检索", "records");
  if (!object(candidate.summary)) fail("财务检索", "summary");
  const summary = candidate.summary as Record<string, unknown>;
  const summaryNumbers = ["totalRecords", "rechargeOrderCny", "subscriptionOrderCny", "walletCreditCny", "walletDebitCny", "walletNetCny", "customerChargeCny", "usageUnits"];
  const optionalSummaryNumbers = ["fixtureRechargeOrderCny", "verifiedRechargeOrderCny", "pointPackOrderCny", "pointPackOrderCount", "pointPackOrderWorkspaceCount", "onboardingOrderCny", "onboardingOrderCount", "onboardingOrderWorkspaceCount"];
  if (summaryNumbers.some(key => !finite(summary[key])) || optionalSummaryNumbers.some(key => summary[key] !== undefined && !finite(summary[key])) || (summary.providerCostCny !== null && !finite(summary.providerCostCny)) || (summary.providerCostStatus !== undefined && !["verified", "partial", "unavailable"].includes(String(summary.providerCostStatus))) || (summary.providerStatementStatus !== undefined && !["not_checked", "needs_review", "balanced", "unavailable"].includes(String(summary.providerStatementStatus))) || (summary.missingCostEvidenceCount !== undefined && !finite(summary.missingCostEvidenceCount)) || !object(summary.byKind)) fail("财务检索", "summary");
  if (summary.subscriptionOrderWorkspaceCount !== undefined && !finite(summary.subscriptionOrderWorkspaceCount)) fail("财务检索", "summary.subscriptionOrderWorkspaceCount");
  const byKind = summary.byKind as Record<string, unknown>;
  if (financeRecordKinds.some(kind => !finite(byKind[kind]))) fail("财务检索", "summary.byKind");
  if (summary.subscriptionOrderBySku !== undefined && (!object(summary.subscriptionOrderBySku) || Object.values(summary.subscriptionOrderBySku).some(value => !object(value) || !finite(value.orderCount) || !finite(value.workspaceCount)))) fail("财务检索", "summary.subscriptionOrderBySku");
  if (summary.commercialOrderBySku !== undefined && (!object(summary.commercialOrderBySku) || Object.values(summary.commercialOrderBySku).some(value => !object(value) || !finite(value.orderCount) || !finite(value.workspaceCount)))) fail("财务检索", "summary.commercialOrderBySku");
  if (!text(candidate.snapshotAt) || !object(candidate.scope)) fail("财务检索", "pagination/scope");
  const scope = candidate.scope as Record<string, unknown>;
  if (!["platform_ops", "finance"].includes(String(scope.role)) || !finite(scope.workspaceCount) || !optionalText(candidate.nextCursor)) fail("财务检索", "pagination/scope");
  return value as unknown as FinanceSearchPage;
};

export const parseFinanceDetail = (value: unknown): FinanceRecordDetail =>
  financeRecord(value, true) ? value as FinanceRecordDetail : fail("财务详情", "record");

export const parseFinanceExport = (value: unknown): FinanceExport => {
  if (!object(value) || !text(value.exportId) || !text(value.fileName) || value.contentType !== "text/csv; charset=utf-8" || typeof value.csv !== "string" || !finite(value.rowCount) || !bool(value.truncated) || !text(value.snapshotAt)) fail("财务导出", "file");
  return value as unknown as FinanceExport;
};

const auditRecord = (value: unknown, detail = false): boolean => {
  if (!object(value)) return false;
  if (!["id", "workspaceId", "actorId", "action", "resourceType", "resourceId", "occurredAt"].every(key => text(value[key])) || typeof value.reason !== "string" || !auditSources.includes(value.source as never) || value.redacted !== true) return false;
  if (containsFixtureMarker(value)) return false;
  if (!detail) return true;
  return object(value.evidence) && value.evidence.redacted === true && finite(value.evidence.omittedFields) && object(value.evidence.fields) && Object.values(value.evidence.fields).every(scalar);
};

export const parseAuditCenterPage = (value: unknown): AuditCenterPage => {
  if (!object(value)) fail("审计列表", "response");
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.records) || !candidate.records.every(record => auditRecord(record)) || !finite(candidate.totalRecords) || candidate.totalRecords < 0 || !bool(candidate.truncated) || !optionalText(candidate.nextCursor)) fail("审计列表", "records/pagination");
  return value as unknown as AuditCenterPage;
};

export const parseAuditDetail = (value: unknown): AuditCenterDetail =>
  auditRecord(value, true) ? value as AuditCenterDetail : fail("审计详情", "record/evidence");

export const parseAuditExport = (value: unknown): AuditCenterExport => {
  if (!object(value) || !text(value.exportId) || !text(value.fileName) || value.contentType !== "text/csv; charset=utf-8" || typeof value.csv !== "string" || !finite(value.rowCount) || !bool(value.truncated)) fail("审计导出", "file");
  return value as unknown as AuditCenterExport;
};

export const incidentsClient: IncidentsClient = {
  list: async (input) => parseIncidentPage(await rpc("ops.incidents.list", {
    ...(input.platformScope ? { platform_scope: "platform" } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: String(input.limit),
  })),
  get: async (incidentId: string) => {
    const value = await rpc("ops.incident.get", { incident_id: incidentId });
    if (!incident(value)) fail("事故详情", "incident");
    return value as import("../hooks/useIncidents.js").OpsIncident;
  },
  timeline: async (input) => parseIncidentTimelinePage(await rpc("ops.incident.timeline", { incident_id: input.incidentId, limit: String(input.limit), ...(input.cursor ? { cursor: input.cursor } : {}) })),
  create: async (input) => parseIncidentMutation(await rpc("ops.incident.create", {
    title: input.title, summary: input.summary, severity: input.severity,
    ...(input.commanderId ? { commander_id: input.commanderId } : {}),
    affected_components_json: JSON.stringify(input.affectedComponents),
    affected_workspace_ids_json: JSON.stringify(input.affectedWorkspaceIds),
    idempotency_key: input.idempotencyKey,
  })),
  comment: async (input) => parseIncidentMutation(await rpc("ops.incident.comment", { incident_id: input.incidentId, expected_revision: String(input.expectedRevision), body: input.body, idempotency_key: input.idempotencyKey })),
  transition: async (input) => parseIncidentMutation(await rpc("ops.incident.transition", { incident_id: input.incidentId, expected_revision: String(input.expectedRevision), to_status: input.toStatus, note: input.note, idempotency_key: input.idempotencyKey })),
  assignCommander: async (input) => parseIncidentMutation(await rpc("ops.incident.commander.assign", { incident_id: input.incidentId, expected_revision: String(input.expectedRevision), ...(input.commanderId ? { commander_id: input.commanderId } : {}), note: input.note, idempotency_key: input.idempotencyKey })),
  updateScope: async (input) => parseIncidentMutation(await rpc("ops.incident.scope.update", { incident_id: input.incidentId, expected_revision: String(input.expectedRevision), affected_components_json: JSON.stringify(input.affectedComponents), affected_workspace_ids_json: JSON.stringify(input.affectedWorkspaceIds), note: input.note, idempotency_key: input.idempotencyKey })),
};

export const supportClient: SupportDomainClient = {
  list: async (input) => parseSupportPage(await rpcForWorkspace(input.workspaceId, "ops.support.tickets.list", {
    ...(input.platformScope ? { platform_scope: "platform" } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.slaState ? { sla_state: input.slaState } : {}),
    ...(input.assigneeId ? { assignee_id: input.assigneeId } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.customerId ? { customer_id: input.customerId } : {}),
    ...(input.cursor ? { cursor_json: JSON.stringify(input.cursor) } : {}),
    limit: String(input.limit),
  })),
  get: async (workspaceId, ticketId) => parseSupportDetail(await rpcForWorkspace(workspaceId, "ops.support.ticket.get", { ticket_id: ticketId })),
  create: async (input) => parseSupportMutation(await rpcForWorkspace(input.workspaceId, "ops.support.ticket.create", {
    subject: input.subject, description: input.description, priority: input.priority,
    customer_id: input.customerId, customer_name: input.customerName,
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    ...(input.relatedOrderId ? { related_order_id: input.relatedOrderId } : {}),
    ...(input.relatedTaskId ? { related_task_id: input.relatedTaskId } : {}),
    tags_json: JSON.stringify(input.tags ?? []), idempotency_key: input.idempotencyKey,
  })),
  assign: async (input) => parseSupportMutation(await rpcForWorkspace(input.workspaceId, "ops.support.ticket.assign", { ticket_id: input.ticketId, assignee_id: input.assigneeId, expected_revision: String(input.expectedRevision), idempotency_key: input.idempotencyKey })),
  transition: async (input) => parseSupportMutation(await rpcForWorkspace(input.workspaceId, "ops.support.ticket.transition", { ticket_id: input.ticketId, status: input.status, reason: input.reason, expected_revision: String(input.expectedRevision), idempotency_key: input.idempotencyKey })),
  comment: async (input) => parseSupportMutation(await rpcForWorkspace(input.workspaceId, "ops.support.ticket.comment", { ticket_id: input.ticketId, body: input.body, visibility: input.visibility, expected_revision: String(input.expectedRevision), idempotency_key: input.idempotencyKey })),
  report: async (input) => parseSupportSlaReport(await rpcForWorkspace<SupportSlaMonthlyReport>(input.workspaceId, "ops.support.sla.report", { period_start: input.periodStart, period_end: input.periodEnd, cutoff_at: input.cutoffAt, ...(input.reportId ? { report_id: input.reportId } : {}) })),
  createCorrection: async (input) => parseSupportSlaCorrection(await rpcForWorkspace<SupportSlaCorrectionRun | { status: "no_change"; original_report_id: string; checksum: string }>(input.workspaceId, "ops.support.sla.correction.create", { original_report_id: input.originalReportId, period_start: input.periodStart, period_end: input.periodEnd, cutoff_at: input.cutoffAt, reason: input.reason, idempotency_key: input.idempotencyKey })),
  decideCorrection: async (input) => parseSupportSlaCorrectionDecision(await rpcForWorkspace<SupportSlaCorrectionDecision | SupportSlaCorrectionApprovalProgress>(input.workspaceId, "ops.support.sla.correction.decide", { correction_id: input.correctionId, decision: input.decision, reason: input.reason, idempotency_key: input.idempotencyKey })),
};

const financeQueryParams = (query: FinanceSearchQuery, includeCursor = true): Record<string, string> => ({
  ...(query.workspaceIds?.length ? { workspace_ids_json: JSON.stringify(query.workspaceIds) } : {}),
  ...(query.kinds?.length ? { kinds_json: JSON.stringify(query.kinds) } : {}),
  ...(query.statuses?.length ? { statuses_json: JSON.stringify(query.statuses) } : {}),
  ...(query.text ? { text: query.text } : {}),
  ...(query.fromAt ? { from_at: query.fromAt } : {}),
  ...(query.toAt ? { to_at: query.toAt } : {}),
  ...(includeCursor && query.cursor ? { cursor: query.cursor } : {}),
  ...(query.snapshotAt ? { snapshot_at: query.snapshotAt } : {}),
  limit: String(query.limit),
});

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
};

export const financeSearchClient: FinanceSearchClient = {
  search: async (query, signal) => {
    throwIfAborted(signal);
    const response = parseFinanceSearchPage(await rpc("ops.finance.search", financeQueryParams(query), { signal }));
    throwIfAborted(signal);
    return response;
  },
  detail: async (input, signal) => {
    throwIfAborted(signal);
    const response = parseFinanceDetail(await rpc("ops.finance.detail", {
      target_workspace_id: input.workspaceId,
      kind: input.kind,
      record_id: input.id,
      expected_version: input.expectedVersion,
      snapshot_at: input.snapshotAt,
    }, { signal }));
    throwIfAborted(signal);
    return response;
  },
  exportCsv: async (query, signal) => {
    throwIfAborted(signal);
    const response = parseFinanceExport(await rpc("ops.finance.export", financeQueryParams(query, false), { signal, timeoutMs: OPS_EXPORT_TIMEOUT_MS, maxResponseBytes: MAX_OPS_EXPORT_RESPONSE_BYTES }));
    throwIfAborted(signal);
    return response;
  },
};

const auditQueryParams = (query: AuditCenterQuery, includeCursor = true): Record<string, string> => ({
  workspace_id: query.workspaceId,
  ...(query.text ? { text: query.text } : {}),
  ...(query.sources?.length ? { sources_json: JSON.stringify(query.sources) } : {}),
  ...(query.actorId ? { actor_id: query.actorId } : {}),
  ...(query.action ? { action: query.action } : {}),
  ...(query.resourceType ? { resource_type: query.resourceType } : {}),
  ...(query.fromAt ? { from_at: query.fromAt } : {}),
  ...(query.toAt ? { to_at: query.toAt } : {}),
  ...(includeCursor && query.cursor ? { cursor: query.cursor } : {}),
  ...(includeCursor ? { limit: String(query.limit) } : {}),
});
const auditPlatformQueryParams = (query: AuditCenterFilters): Record<string, string> => ({
  ...(query.text ? { text: query.text } : {}),
  ...(query.sources?.length ? { sources_json: JSON.stringify(query.sources) } : {}),
  ...(query.actorId ? { actor_id: query.actorId } : {}),
  ...(query.action ? { action: query.action } : {}),
  ...(query.resourceType ? { resource_type: query.resourceType } : {}),
  ...(query.fromAt ? { from_at: query.fromAt } : {}),
  ...(query.toAt ? { to_at: query.toAt } : {}),
  limit: "100",
});

export const auditCenterClient: AuditCenterClient = {
  list: async (query, signal) => {
    throwIfAborted(signal);
    const response = parseAuditCenterPage(
      await rpcForWorkspace(query.workspaceId, "ops.audit.list", auditQueryParams(query), { signal }),
    );
    throwIfAborted(signal);
    return response;
  },
  listPlatform: async (query, signal) => {
    throwIfAborted(signal);
    const response = parseAuditCenterPage(await rpc("ops.audit.platform.list", auditPlatformQueryParams(query), { signal }));
    throwIfAborted(signal);
    return response;
  },
  detail: async (input, signal) => {
    throwIfAborted(signal);
    const response = parseAuditDetail(await rpcForWorkspace(input.workspaceId, "ops.audit.detail", { source: input.source, id: input.id, workspace_id: input.workspaceId }, { signal }));
    throwIfAborted(signal);
    return response;
  },
  exportCsv: async (query, signal) => {
    throwIfAborted(signal);
    const response = parseAuditExport(await rpcForWorkspace(query.workspaceId, "ops.audit.export", auditQueryParams(query, false), { signal, timeoutMs: OPS_EXPORT_TIMEOUT_MS, maxResponseBytes: MAX_OPS_EXPORT_RESPONSE_BYTES }));
    throwIfAborted(signal);
    return response;
  },
};
