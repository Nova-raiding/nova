import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuthorizationProjection } from "../../authz/authorization.js";
import { buildPublicRuleStatusParams, canReviewPublicRuleDraft, parsePublicRuleDraftList, PublicRuleDraftReviewPanel } from "./PublicRuleDraftReviewPanel.js";

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
    expect(() => parsePublicRuleDraftList({ items: [], next_cursor: {} })).toThrow("游标格式无效");
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

  it("renders only for a platform rule reader and keeps approval controls behind write capability", () => {
    expect(renderToStaticMarkup(<PublicRuleDraftReviewPanel authorization={authorization("workspace", ["rule.read"])} />)).toBe("");
    const readOnly = renderToStaticMarkup(<PublicRuleDraftReviewPanel authorization={authorization("platform", ["rule.read"])} />);
    expect(readOnly).toContain("公共平台规则草稿审核");
    expect(readOnly).toContain("只读审核视图");
    expect(readOnly).not.toContain("审批并激活");
  });
});
