import { FEATURE_FLAG_TARGET_TYPES, FEATURE_FLAG_VALUE_TYPES, type FeatureFlag, type FeatureFlagEmergencyRequest, type FeatureFlagEvent, type FeatureFlagListRequest, type FeatureFlagMutationRequest, type FeatureFlagPage } from "../../../../packages/contracts/src/ops/feature-flags.js";
import { financeRecordKinds, type FinanceExport, type FinanceRecordDetail, type FinanceSearchPage, type FinanceSearchQuery } from "../../../../packages/contracts/src/ops/finance-search.js";
import type { SupportDomainClient } from "../hooks/useSupportDomain.js";
import type { FeatureFlagsClient } from "../hooks/useFeatureFlags.js";
import type { FinanceSearchClient } from "../hooks/useFinanceSearch.js";
import type { IncidentsClient } from "../hooks/useIncidents.js";
import type { AuditCenterClient, AuditCenterFilters } from "../hooks/useAuditCenter.js";
import { supportTicketEventTypes, supportTicketPriorities, supportTicketStatuses, type SupportCrmExportContract, type SupportTicketContract, type SupportTicketEventContract, type SupportTicketPageContract } from "../../../../packages/contracts/src/ops/support.js";
import { incidentSeverities, incidentStatuses } from "../../../../packages/contracts/src/ops/incidents.js";
import { auditSources, type AuditCenterExport, type AuditCenterPage, type AuditCenterDetail, type AuditCenterQuery } from "../../../../packages/contracts/src/ops/audit-center.js";
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

const typedFlagValue = (value: unknown) => object(value)
  && FEATURE_FLAG_VALUE_TYPES.includes(value.type as never)
  && Object.prototype.hasOwnProperty.call(value, "value");
const featureFlagTarget = (value: unknown) => object(value)
  && FEATURE_FLAG_TARGET_TYPES.includes(value.type as never)
  && text(value.value) && bool(value.enabled)
  && (value.override === undefined || typedFlagValue(value.override));
const featureFlag = (value: unknown): value is FeatureFlag => object(value)
  && ["id", "key", "environment", "description", "createdBy", "updatedBy", "createdAt", "updatedAt"].every(key => text(value[key]))
  && typedFlagValue(value.defaultValue) && bool(value.enabled) && bool(value.emergencyDisabled)
  && Array.isArray(value.targets) && value.targets.every(featureFlagTarget)
  && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1
  && optionalText(value.validFrom) && optionalText(value.validTo);
const featureFlagEvent = (value: unknown): value is FeatureFlagEvent => object(value)
  && ["id", "flagId", "actorId", "reason", "idempotencyKey", "createdAt"].every(key => text(value[key]))
  && ["created", "updated", "emergency_disabled", "emergency_restored"].includes(String(value.eventType))
  && featureFlag(value.after) && (value.before === undefined || featureFlag(value.before));

export const parseFeatureFlagPage = (value: unknown): FeatureFlagPage => {
  if (!object(value) || !Array.isArray(value.items) || !value.items.every(featureFlag) || !optionalText(value.nextCursor)) fail("功能开关列表", "items/pagination");
  return value as unknown as FeatureFlagPage;
};
export const parseFeatureFlagMutation = (value: unknown): { flag: FeatureFlag; replayed: boolean } => {
  if (!object(value) || !featureFlag(value.flag) || !bool(value.replayed)) fail("功能开关变更", "flag/replayed");
  return value as unknown as { flag: FeatureFlag; replayed: boolean };
};
export const parseFeatureFlagEvents = (value: unknown): FeatureFlagEvent[] =>
  Array.isArray(value) && value.every(featureFlagEvent) ? value : fail("功能开关审计", "events");

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
  && textArray(value.tags) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1
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
export const parseSupportCrmExport = (value: unknown): SupportCrmExportContract => {
  if (!object(value) || !text(value.generatedAt) || !text(value.workspaceId) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) fail("客服 CRM 导出", "export");
  return value as unknown as SupportCrmExportContract;
};

const financeRecord = (value: unknown, detail = false): boolean => {
  if (!object(value)) return false;
  const requiredText = ["id", "workspaceId", "status", "label", "occurredAt", "updatedAt", "version"];
  if (requiredText.some(key => !text(value[key]))) return false;
  if (!financeRecordKinds.includes(value.kind as never) || value.redacted !== true) return false;
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
  const summaryNumbers = ["totalRecords", "rechargeOrderCny", "subscriptionOrderCny", "walletCreditCny", "walletDebitCny", "walletNetCny", "providerCostCny", "customerChargeCny", "usageUnits"];
  if (summaryNumbers.some(key => !finite(summary[key])) || !object(summary.byKind)) fail("财务检索", "summary");
  const byKind = summary.byKind as Record<string, unknown>;
  if (financeRecordKinds.some(kind => !finite(byKind[kind]))) fail("财务检索", "summary.byKind");
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

export const featureFlagsClient: FeatureFlagsClient = {
  list: async (input: FeatureFlagListRequest) => parseFeatureFlagPage(await rpc("ops.feature-flags.list", {
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit ? { limit: String(input.limit) } : {}),
  })),
  save: async (input: FeatureFlagMutationRequest) => parseFeatureFlagMutation(await rpc("ops.feature-flag.upsert", {
    ...(input.id ? { id: input.id } : {}),
    key: input.key,
    environment: input.environment,
    description: input.description,
    default_value_json: JSON.stringify(input.defaultValue),
    enabled: String(input.enabled ?? false),
    targets_json: JSON.stringify(input.targets ?? []),
    ...(input.validFrom ? { valid_from: input.validFrom } : {}),
    ...(input.validTo ? { valid_to: input.validTo } : {}),
    ...(input.expectedRevision !== undefined ? { expected_revision: String(input.expectedRevision) } : {}),
    idempotency_key: input.idempotencyKey,
    reason: input.reason,
  })),
  setEmergency: async (input: FeatureFlagEmergencyRequest) => parseFeatureFlagMutation(await rpc("ops.feature-flag.emergency.set", {
    id: input.id,
    disabled: String(input.disabled),
    expected_revision: String(input.expectedRevision),
    idempotency_key: input.idempotencyKey,
    reason: input.reason,
  })),
  events: async (flagId: string) => parseFeatureFlagEvents(await rpc("ops.feature-flag.events", { flag_id: flagId, limit: "100" })),
};

export const incidentsClient: IncidentsClient = {
  list: async (input) => parseIncidentPage(await rpc("ops.incidents.list", {
    ...(input.platformScope ? { platform_scope: "platform" } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: String(input.limit),
  })),
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
    ...(input.query ? { query: input.query } : {}),
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
  exportCrm: async (workspaceId) => parseSupportCrmExport(await rpcForWorkspace(workspaceId, "ops.support.crm.export", { limit: "5000" })),
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
