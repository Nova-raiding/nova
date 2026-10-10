import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuthorizationProjection } from "../../authz/authorization.js";
import { buildPublicRuleBatchApprovalParams, buildPublicRuleDraftListParams, buildPublicRuleStatusParams, canReviewPublicRuleDraft, isPublicRuleApprovalTimestamp, parsePublicRuleDraftList, PublicRuleDraftReviewPanel } from "./PublicRuleDraftReviewPanel.js";

function authorization(scope: "platform" | "workspace", capabilities: string[]): AuthorizationProjection {
  const allowed = new Set(capabilities);
  return { managed: true, roles: [], capabilities: allowed, deniedCapabilities: new Set(), capabilityScopes: new Map(), scope: { kind: scope }, policyVersion: "test", source: "server", can: capability => allowed.has(capability), canAny: values => values.some(value => allowed.has(value)), scopeFor: () => undefined };
}

const pending = {
  id: "public-rule-1", platform: "pinduoduo" as const, pack_id: "pdd-delivery", name: "发货规则", version: "1.0", status: "draft",
  source: { kind: "internal", reference: "manual://rules.md#PDD-1", checked_at: "2026-09-01T00:00:00.000Z", trust: "manual_pending_review" },
  checksum: "a".repeat(64), checksum_valid: true, created_by: "writer-1", created_at: "2026-09-01T00:00:00.000Z", revision: 1,
};

describe("public platform rule draft review", () => {
  it("validates list response shape and pagination cursor", () => {
    expect(parsePublicRuleDraftList({ items: [pending], next_cursor: "next" })).toMatchObject({ items: [pending], nextCursor: "next" });
    expect(() => parsePublicRuleDraftList({ items: [{ ...pending, checksum_valid: "yes" }] })).toThrow("字段不完整");
    expect(() => parsePublicRuleDraftList({ items: [{ ...pending, platform: "unknown-platform" }] })).toThrow("字段不完整");
    expect(() => parsePublicRuleDraftList({ items: [{ ...pending, revision: 0 }] })).toThrow("字段不完整");
    expect(() => parsePublicRuleDraftList({ items: [{ ...pending, created_at: "not-a-date" }] })).toThrow("字段不完整");
    expect(() => parsePublicRuleDraftList({ items: [], next_cursor: {} })).toThrow("游标格式无效");
  });

  it("uses cursor pagination with a bounded page size", () => {
    expect(buildPublicRuleDraftListParams("pinduoduo")).toEqual({ platform: "pinduoduo", limit: "20" });
    expect(buildPublicRuleDraftListParams("", "cursor-page-2")).toEqual({ limit: "20", cursor: "cursor-page-2" });
  });

  it("requires a real ISO 8601 timestamp with an explicit timezone for approval", () => {
    expect(isPublicRuleApprovalTimestamp("2026-10-09T08:00:00.000Z")).toBe(true);
    expect(isPublicRuleApprovalTimestamp("2026-10-09T08:00:00+08:00")).toBe(true);
    expect(isPublicRuleApprovalTimestamp("2026-02-31T08:00:00Z")).toBe(false);
    expect(isPublicRuleApprovalTimestamp("2026-10-09T08:60:00Z")).toBe(false);
    expect(isPublicRuleApprovalTimestamp("2026-10-09T08:00:00")).toBe(false);
    expect(isPublicRuleApprovalTimestamp("approval time")).toBe(false);
  });

  it("requires platform read and update plus verified pending evidence to approve", () => {
    const platformWriter = authorization("platform", ["rule.read", "rule.update"]);
    expect(canReviewPublicRuleDraft(platformWriter, pending)).toBe(true);
    expect(canReviewPublicRuleDraft(authorization("workspace", ["rule.read", "rule.update"]), pending)).toBe(false);
    expect(canReviewPublicRuleDraft(authorization("platform", ["rule.read"]), pending)).toBe(false);
    expect(canReviewPublicRuleDraft(platformWriter, { ...pending, checksum_valid: false })).toBe(false);
    expect(canReviewPublicRuleDraft(platformWriter, { ...pending, status: "active" })).toBe(false);
    expect(canReviewPublicRuleDraft(platformWriter, { ...pending, source: { ...pending.source, trust: "unverified" } })).toBe(false);
  });

  it("pins both approve and reject transitions to the revision loaded for review", () => {
    expect(buildPublicRuleStatusParams(pending, "active", "审批通过", { approvalRef: "APR-1", approvedBy: "reviewer-2", approvedAt: "2026-09-02T00:00:00.000Z" }))
      .toMatchObject({ status: "active", expected_revision: "1", public_scope: "platform", platform: "pinduoduo", approval_json: JSON.stringify({ approval_ref: "APR-1", approved_by: "reviewer-2", approved_at: "2026-09-02T00:00:00.000Z" }) });
    expect(buildPublicRuleStatusParams(pending, "inactive", "拒绝", undefined))
      .toMatchObject({ status: "inactive", expected_revision: "1", public_scope: "platform", platform: "pinduoduo" });
  });

  it("builds one batch request with each rule's revision and approval evidence", () => {
    const second = { ...pending, id: "public-rule-2", pack_id: "pdd-image", revision: 4 };
    const params = buildPublicRuleBatchApprovalParams([pending, second], "批量复核", { approvalRef: "APR-BATCH", approvedBy: "reviewer-2", approvedAt: "2026-09-02T00:00:00.000Z" });
    expect(Object.keys(params)).toEqual(["items_json"]);
    expect(JSON.parse(params.items_json)).toEqual([
      { platform: "pinduoduo", pack_id: "pdd-delivery", version: "1.0", expected_revision: "1", reason: "批量复核", approval_ref: "APR-BATCH", approved_by: "reviewer-2", approved_at: "2026-09-02T00:00:00.000Z" },
      { platform: "pinduoduo", pack_id: "pdd-image", version: "1.0", expected_revision: "4", reason: "批量复核", approval_ref: "APR-BATCH", approved_by: "reviewer-2", approved_at: "2026-09-02T00:00:00.000Z" },
    ]);
  });

  it("omits an absent cursor and trims batch approval evidence before serialization", () => {
    expect(buildPublicRuleDraftListParams("", undefined)).toEqual({ limit: "20" });
    expect(JSON.parse(buildPublicRuleBatchApprovalParams([pending], "  批量复核  ", {
      approvalRef: "  APR-TRIM  ", approvedBy: "  reviewer-2  ", approvedAt: "  2026-09-02T00:00:00.000Z  ",
    }).items_json)).toEqual([expect.objectContaining({
      reason: "批量复核", approval_ref: "APR-TRIM", approved_by: "reviewer-2", approved_at: "2026-09-02T00:00:00.000Z",
    })]);
  });

  it("renders only for a platform rule reader and keeps approval controls behind write capability", () => {
    expect(renderToStaticMarkup(<PublicRuleDraftReviewPanel authorization={authorization("workspace", ["rule.read"])} />)).toBe("");
    const readOnly = renderToStaticMarkup(<PublicRuleDraftReviewPanel authorization={authorization("platform", ["rule.read"])} />);
    expect(readOnly).toContain("公共平台规则草稿审核");
    expect(readOnly).toContain("只读审核视图");
    expect(readOnly).not.toContain("审批并激活");
  });

  it("does not expose batch approval without the dedicated publish capability", () => {
    const html = renderToStaticMarkup(<PublicRuleDraftReviewPanel authorization={authorization("platform", ["rule.read", "rule.update"])} />);
    expect(html).toContain("公共平台规则草稿审核");
    expect(html).not.toContain("一键审批选中");
    expect(html).not.toContain("审批并激活");
  });
});
