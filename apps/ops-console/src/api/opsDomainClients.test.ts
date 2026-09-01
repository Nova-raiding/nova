import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_METHOD_CONTRACTS } from "../../../../packages/contracts/src/mcp.js";
import type { AuditCenterQuery } from "../../../../packages/contracts/src/ops/audit-center.js";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn<(method: string, params: Record<string, string>) => Promise<unknown>>(async () => ({})),
  rpcForWorkspace: vi.fn<(workspaceId: string, method: string, params: Record<string, string>) => Promise<unknown>>(async () => ({})),
  OPS_EXPORT_TIMEOUT_MS: 30_000,
  MAX_OPS_EXPORT_RESPONSE_BYTES: 16 * 1024 * 1024,
}));

vi.mock("./opsClient.js", () => mocks);

import {
  auditCenterClient,
  featureFlagsClient,
  financeSearchClient,
  incidentsClient,
  parseAuditCenterPage,
  parseAuditDetail,
  parseAuditExport,
  parseFeatureFlagPage,
  parseIncidentPage,
  parseFinanceDetail,
  parseFinanceExport,
  parseFinanceSearchPage,
  parseSupportPage,
  parseSupportSlaReport,
  supportClient,
} from "./opsDomainClients.js";

interface WireCall {
  method: string;
  params: Record<string, string>;
}

const calls = (): WireCall[] => [
  ...mocks.rpc.mock.calls.map(([method, params], index) => ({
    method,
    params,
    order: mocks.rpc.mock.invocationCallOrder[index],
  })),
  ...mocks.rpcForWorkspace.mock.calls.map(([, method, params], index) => ({
    method,
    params,
    order: mocks.rpcForWorkspace.mock.invocationCallOrder[index],
  })),
].sort((left, right) => left.order - right.order);

describe("Ops domain protocol clients", () => {
  const financeRecord = { id: "record-1", kind: "recharge_order", workspaceId: "ws-1", status: "paid", label: "充值订单", occurredAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", version: "v1", redacted: true } as const;
  const auditRecord = { id: "audit-1", source: "operation", workspaceId: "ws-ops", actorId: "operator-1", action: "refund", resourceType: "order", resourceId: "order-1", reason: "approved", occurredAt: "2026-08-29T00:00:00.000Z", redacted: true } as const;
  const flag = { id: "flag-1", key: "checkout.enabled", environment: "production", description: "Checkout rollout", defaultValue: { type: "boolean", value: true }, enabled: true, emergencyDisabled: false, targets: [], revision: 1, createdBy: "operator-1", updatedBy: "operator-1", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" } as const;
  const incident = { id: "incident-1", workspaceId: "ws-ops", title: "Provider outage", summary: "Provider calls are failing", severity: "sev1", status: "investigating", affectedComponents: ["api"], affectedWorkspaceIds: ["ws-1"], revision: 1, createdBy: "operator-1", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" } as const;
  const incidentEvent = { id: "event-1", workspaceId: "ws-ops", incidentId: "incident-1", kind: "created", body: "Created", actorId: "operator-1", incidentRevision: 1, createdAt: "2026-08-29T00:00:00.000Z" } as const;
  const ticket = { id: "ticket-1", workspaceId: "ws-ops", ticketNumber: "SUP-1", subject: "Payment missing", description: "Customer payment is not reflected", status: "open", priority: "urgent", customerId: "customer-1", customerName: "Customer One", tags: ["billing"], revision: 1, createdBy: "operator-1", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" } as const;
  const ticketEvent = { id: "ticket-event-1", workspaceId: "ws-ops", ticketId: "ticket-1", sequence: 1, eventType: "created", actorId: "operator-1", idempotencyKey: "ticket-create-0001", payload: {}, createdAt: "2026-08-29T00:00:00.000Z" } as const;
  const responseFor = (method: string): unknown => {
    if (method === "ops.feature-flags.list") return { items: [flag] };
    if (method === "ops.feature-flag.upsert" || method === "ops.feature-flag.emergency.set") return { flag, replayed: false };
    if (method === "ops.feature-flag.events") return [{ id: "flag-event-1", flagId: flag.id, eventType: "created", actorId: "operator-1", reason: "created", idempotencyKey: "flag-save-0001", after: flag, createdAt: flag.createdAt }];
    if (method === "ops.incidents.list") return { items: [incident] };
    if (method === "ops.incident.timeline") return { items: [incidentEvent] };
    if (method.startsWith("ops.incident.")) return { incident, event: incidentEvent };
    if (method === "ops.support.tickets.list") return { items: [ticket] };
    if (method === "ops.support.ticket.get") return { ticket, events: [ticketEvent] };
    if (method.startsWith("ops.support.ticket.")) return { ticket, event: ticketEvent, replayed: false };
    if (method === "ops.support.crm.export") return { generatedAt: ticket.createdAt, workspaceId: "ws-ops", columns: ["customer_id", "customer_name", "customer_email", "total_tickets", "open_tickets", "urgent_tickets", "last_ticket_at", "last_ticket_status"], rows: [] };
    if (method === "ops.support.sla.report") return { reportId: "run-1", workspaceId: "ws-ops", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", cutoffAt: "2026-09-03T00:00:00.000Z", policyVersions: [1], calendarVersions: ["business_weekday_utc"], denominator: 1, met: 1, failed: 0, excluded: 0, lateOrUnresolved: 0, checksum: "a".repeat(64), ticketResults: [] };
    if (method === "ops.finance.search") return { records: [financeRecord], summary: { totalRecords: 1, rechargeOrderCny: 1, subscriptionOrderCny: 0, walletCreditCny: 0, walletDebitCny: 0, walletNetCny: 0, providerCostCny: 0, customerChargeCny: 0, usageUnits: 0, byKind: { recharge_order: 1, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 } }, snapshotAt: "2026-08-29T00:00:00.000Z", scope: { role: "platform_ops", workspaceCount: 1 } };
    if (method === "ops.finance.detail") return { ...financeRecord, attributes: { provider: "wechat" } };
    if (method === "ops.finance.export") return { exportId: "export-1", fileName: "finance.csv", contentType: "text/csv; charset=utf-8", csv: "id\nrecord-1", rowCount: 1, truncated: false, snapshotAt: "2026-08-29T00:00:00.000Z" };
    if (method === "ops.audit.list") return { records: [auditRecord], totalRecords: 1, truncated: false };
    if (method === "ops.audit.detail") return { ...auditRecord, evidence: { redacted: true, fields: { status: "paid" }, omittedFields: 1 } };
    if (method === "ops.audit.export") return { exportId: "export-2", fileName: "audit.csv", contentType: "text/csv; charset=utf-8", csv: "id\naudit-1", rowCount: 1, truncated: false };
    return {};
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockImplementation(async (method) => responseFor(method));
    mocks.rpcForWorkspace.mockImplementation(async (_workspaceId, method) => responseFor(method));
  });

  it("uses the canonical MCP method and wire envelope for every exported client call", async () => {
    await featureFlagsClient.list({ environment: "production", query: "checkout", cursor: "flag-cursor", limit: 50 });
    await featureFlagsClient.save({
      id: "flag-1",
      key: "checkout.enabled",
      environment: "production",
      description: "Checkout rollout",
      defaultValue: { type: "boolean", value: true },
      enabled: true,
      targets: [{ type: "workspace", value: "ws-target", enabled: true }],
      validFrom: "2026-08-29T00:00:00.000Z",
      validTo: "2026-09-29T00:00:00.000Z",
      expectedRevision: 7,
      idempotencyKey: "flag-save-0001",
      reason: "Enable checkout rollout",
    });
    await featureFlagsClient.setEmergency({ id: "flag-1", disabled: true, expectedRevision: 8, idempotencyKey: "flag-stop-0001", reason: "Stop failed rollout" });
    await featureFlagsClient.events("flag-1");

    await incidentsClient.list({ status: "investigating", severity: "sev1", cursor: "incident-cursor", limit: 50 });
    await incidentsClient.list({ platformScope: true, limit: 5 });
    await incidentsClient.timeline({ incidentId: "incident-1", cursor: "timeline-cursor", limit: 100 });
    await incidentsClient.create({ title: "Provider outage", summary: "Provider calls are failing", severity: "sev1", commanderId: "operator-1", affectedComponents: ["api"], affectedWorkspaceIds: ["ws-1"], idempotencyKey: "incident-create-0001" });
    await incidentsClient.comment({ incidentId: "incident-1", expectedRevision: 1, body: "Investigating", idempotencyKey: "incident-comment-0001" });
    await incidentsClient.transition({ incidentId: "incident-1", expectedRevision: 2, toStatus: "identified", note: "Provider failure isolated", idempotencyKey: "incident-transition-0001" });
    await incidentsClient.assignCommander({ incidentId: "incident-1", expectedRevision: 3, commanderId: "operator-2", note: "Shift handoff", idempotencyKey: "incident-commander-0001" });
    await incidentsClient.updateScope({ incidentId: "incident-1", expectedRevision: 4, affectedComponents: ["api", "worker"], affectedWorkspaceIds: ["ws-1", "ws-2"], note: "Impact confirmed", idempotencyKey: "incident-scope-0001" });

    await supportClient.list({ workspaceId: "ws-ops", status: "open", priority: "urgent", query: "payment", cursor: { createdAt: "2026-08-29T00:00:00.000Z", id: "ticket-0" }, limit: 25 });
    await supportClient.list({ workspaceId: "ws-ops", platformScope: true, limit: 5 });
    await supportClient.get("ws-ops", "ticket-1");
    await supportClient.create({ workspaceId: "ws-ops", subject: "Payment missing", description: "Customer payment is not reflected", priority: "urgent", customerId: "customer-1", customerName: "Customer One", customerEmail: "one@example.com", relatedOrderId: "order-1", relatedTaskId: "task-1", tags: ["billing"], idempotencyKey: "ticket-create-0001" });
    await supportClient.assign({ workspaceId: "ws-ops", ticketId: "ticket-1", assigneeId: "operator-1", expectedRevision: 1, idempotencyKey: "ticket-assign-0001" });
    await supportClient.transition({ workspaceId: "ws-ops", ticketId: "ticket-1", status: "in_progress", reason: "Started investigation", expectedRevision: 2, idempotencyKey: "ticket-transition-0001" });
    await supportClient.comment({ workspaceId: "ws-ops", ticketId: "ticket-1", body: "We are checking the payment", visibility: "customer", expectedRevision: 3, idempotencyKey: "ticket-comment-0001" });
    await supportClient.exportCrm("ws-ops");

    const financeQuery = { workspaceIds: ["ws-1", "ws-2"], kinds: ["recharge_order" as const], statuses: ["paid"], text: "order", fromAt: "2026-08-01T00:00:00.000Z", toAt: "2026-08-29T00:00:00.000Z", cursor: "finance-cursor", snapshotAt: "2026-08-29T01:00:00.000Z", limit: 50 };
    await financeSearchClient.search(financeQuery);
    await financeSearchClient.detail({ workspaceId: "ws-1", kind: "recharge_order", id: "order-1", expectedVersion: "version-1", snapshotAt: "2026-08-29T01:00:00.000Z" });
    await financeSearchClient.exportCsv(financeQuery);

    const auditQuery: AuditCenterQuery = { workspaceId: "ws-ops", sources: ["operation", "incident"], text: "refund", actorId: "operator-1", action: "refund", resourceType: "order", fromAt: "2026-08-01T00:00:00.000Z", toAt: "2026-08-29T00:00:00.000Z", cursor: "audit-cursor", limit: 50 };
    await auditCenterClient.list(auditQuery);
    await auditCenterClient.detail({ workspaceId: "ws-ops", source: "operation", id: "audit-1" });
    await auditCenterClient.exportCsv(auditQuery);
    await supportClient.report({ workspaceId: "ws-ops", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", cutoffAt: "2026-09-03T00:00:00.000Z" });

    const expectedMethods = [
      "ops.feature-flags.list",
      "ops.feature-flag.upsert",
      "ops.feature-flag.emergency.set",
      "ops.feature-flag.events",
      "ops.incidents.list",
      "ops.incidents.list",
      "ops.incident.timeline",
      "ops.incident.create",
      "ops.incident.comment",
      "ops.incident.transition",
      "ops.incident.commander.assign",
      "ops.incident.scope.update",
      "ops.support.tickets.list",
      "ops.support.tickets.list",
      "ops.support.ticket.get",
      "ops.support.ticket.create",
      "ops.support.ticket.assign",
      "ops.support.ticket.transition",
      "ops.support.ticket.comment",
      "ops.support.crm.export",
      "ops.finance.search",
      "ops.finance.detail",
      "ops.finance.export",
      "ops.audit.list",
      "ops.audit.detail",
      "ops.audit.export",
      "ops.support.sla.report",
    ];
    expect(calls().map(call => call.method)).toEqual(expectedMethods);

    const contracts = new Map(MCP_METHOD_CONTRACTS.map(contract => [contract.method, contract.params]));
    for (const call of calls()) {
      const contract = contracts.get(call.method as never);
      expect(contract, `${call.method} must have an MCP contract`).toBeDefined();
      expect(Object.keys(call.params).every(key => key in contract!.properties), `${call.method} contains an off-contract parameter`).toBe(true);
      expect(contract!.required?.every(key => key === "workspace_id" || key in call.params) ?? true, `${call.method} omits a required parameter`).toBe(true);
      expect(Object.values(call.params).every(value => typeof value === "string"), `${call.method} must use string wire values`).toBe(true);
    }

    expect(mocks.rpcForWorkspace.mock.calls.every(([workspaceId]) => workspaceId === "ws-ops")).toBe(true);
    expect(calls().find(call => call.method === "ops.incidents.list" && call.params.platform_scope === "platform")).toBeTruthy();
    expect(calls().find(call => call.method === "ops.support.tickets.list" && call.params.platform_scope === "platform")).toBeTruthy();
    expect(calls().find(call => call.method === "ops.feature-flag.upsert")?.params).toEqual({
      id: "flag-1",
      key: "checkout.enabled",
      environment: "production",
      description: "Checkout rollout",
      default_value_json: JSON.stringify({ type: "boolean", value: true }),
      enabled: "true",
      targets_json: JSON.stringify([{ type: "workspace", value: "ws-target", enabled: true }]),
      valid_from: "2026-08-29T00:00:00.000Z",
      valid_to: "2026-09-29T00:00:00.000Z",
      expected_revision: "7",
      idempotency_key: "flag-save-0001",
      reason: "Enable checkout rollout",
    });
    expect(calls().find(call => call.method === "ops.incident.scope.update")?.params).toMatchObject({
      affected_components_json: JSON.stringify(["api", "worker"]),
      affected_workspace_ids_json: JSON.stringify(["ws-1", "ws-2"]),
    });
    expect(calls().find(call => call.method === "ops.support.tickets.list")?.params).toMatchObject({
      cursor_json: JSON.stringify({ createdAt: "2026-08-29T00:00:00.000Z", id: "ticket-0" }),
    });
    expect(calls().find(call => call.method === "ops.finance.search")?.params).toEqual({
      workspace_ids_json: JSON.stringify(["ws-1", "ws-2"]),
      kinds_json: JSON.stringify(["recharge_order"]),
      statuses_json: JSON.stringify(["paid"]),
      text: "order",
      from_at: "2026-08-01T00:00:00.000Z",
      to_at: "2026-08-29T00:00:00.000Z",
      cursor: "finance-cursor",
      snapshot_at: "2026-08-29T01:00:00.000Z",
      limit: "50",
    });
    expect(calls().find(call => call.method === "ops.audit.list")?.params).toEqual({
      workspace_id: "ws-ops",
      text: "refund",
      sources_json: JSON.stringify(["operation", "incident"]),
      actor_id: "operator-1",
      action: "refund",
      resource_type: "order",
      from_at: "2026-08-01T00:00:00.000Z",
      to_at: "2026-08-29T00:00:00.000Z",
      cursor: "audit-cursor",
      limit: "50",
    });
    expect(calls().find(call => call.method === "ops.audit.detail")?.params).toEqual({
      source: "operation",
      id: "audit-1",
      workspace_id: "ws-ops",
    });
    expect(calls().find(call => call.method === "ops.audit.export")?.params).not.toHaveProperty("cursor");
    expect(calls().find(call => call.method === "ops.audit.export")?.params).not.toHaveProperty("limit");
  });

  it("rejects malformed finance and audit responses at the transport boundary", () => {
    expect(() => parseFinanceSearchPage({ records: [] })).toThrow(/无效响应/);
    expect(() => parseFinanceDetail({ ...financeRecord, attributes: [] })).toThrow(/无效响应/);
    expect(() => parseFinanceExport({ fileName: "finance.csv" })).toThrow(/无效响应/);
    expect(() => parseAuditCenterPage({ records: null })).toThrow(/无效响应/);
    expect(() => parseAuditDetail({ ...auditRecord, evidence: { redacted: false } })).toThrow(/无效响应/);
    expect(() => parseAuditExport({ csv: "id" })).toThrow(/无效响应/);
  });

  it("rejects malformed feature flag, incident, and support responses at the transport boundary", () => {
    expect(() => parseFeatureFlagPage({ items: [{ ...flag, revision: 0 }] })).toThrow(/无效响应/);
    expect(() => parseIncidentPage({ items: [{ ...incident, affectedComponents: "api" }] })).toThrow(/无效响应/);
    expect(() => parseSupportPage({ items: [{ ...ticket, status: "invented" }] })).toThrow(/无效响应/);
  });

  it("contains no deprecated Ops domain method names", () => {
    const deprecated = [
      "ops.support.ticket.list",
      "ops.incidents.timeline",
      "ops.incidents.create",
      "ops.incidents.comment",
      "ops.incidents.transition",
      "ops.incidents.commander.assign",
      "ops.incidents.scope.update",
      "ops.feature-flags.save",
      "ops.feature-flags.emergency",
      "ops.feature-flags.events",
    ];
    const implementation = `${featureFlagsClient.list} ${featureFlagsClient.save} ${featureFlagsClient.setEmergency} ${featureFlagsClient.events} ${incidentsClient.list} ${incidentsClient.timeline} ${incidentsClient.create} ${incidentsClient.comment} ${incidentsClient.transition} ${incidentsClient.assignCommander} ${incidentsClient.updateScope} ${supportClient.list}`;
    for (const method of deprecated) expect(implementation).not.toContain(`"${method}"`);
  });
});
