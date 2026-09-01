import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanonicalConsistencySummary } from "./CanonicalConsistencySummary.js";
import type { CanonicalProductConsistencyReport } from "../../types/ops.js";

const finding = { legacyProductId: "product-1", status: "conflict" as const, codes: ["TASK_CANONICAL_SCOPE_MISMATCH"], canonicalProductId: "canonical-1", listingIds: [], campaignItemIds: [], taskIds: ["task-1"], publishJobIds: [] };
describe("CanonicalConsistencySummary", () => {
  it("renders an explicit unavailable state", () => expect(renderToStaticMarkup(<CanonicalConsistencySummary />)).toContain("尚未取得标准商品链检查结果"));
  it("renders summary and product-level status from the existing report contract", () => {
    const markup = renderToStaticMarkup(<CanonicalConsistencySummary report={{ workspaceId: "ws-1", status: "attention_required", counts: { verified: 0, legacy_only: 0, conflict: 1, blocked: 0 }, findings: [finding], orphanFindings: [] }} />);
    expect(markup).toContain("需要处理"); expect(markup).toContain("product-1"); expect(markup).toContain("canonical-1"); expect(markup).toContain("存在冲突"); expect(markup).toContain("TASK_CANONICAL_SCOPE_MISMATCH");
  });
  it("does not claim a clean chain when only orphan findings exist", () => {
    const markup = renderToStaticMarkup(<CanonicalConsistencySummary report={{ workspaceId: "ws-1", status: "attention_required", counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 1 }, findings: [], orphanFindings: [{ entityType: "listing", entityId: "listing-1", status: "blocked", codes: ["LISTING_CANONICAL_ORPHAN"] }] }} />);
    expect(markup).toContain("需要处理"); expect(markup).toContain("另有 1 条未挂接实体记录"); expect(markup).not.toContain("链路正常");
  });

  it("shows product evidence and the server-owned next action in the summary row", () => {
    const markup = renderToStaticMarkup(<CanonicalConsistencySummary report={{ workspaceId: "ws-1", status: "attention_required", generatedAt: "2026-08-31T01:02:03.000Z", freshness: "fresh", counts: { verified: 0, legacy_only: 0, conflict: 1, blocked: 0 }, findings: [{ ...finding, listingIds: ["listing-1"], taskIds: ["task-1"], publishJobIds: ["publish-1"], evidence: { codes: finding.codes, generatedAt: "2026-08-31T01:02:03.000Z", revision: "rev-2" }, nextAction: { id: "map", method: "brand-unit.product.create", label: "补齐规范商品映射", reason: "映射缺失", permission: { allowed: false, requiredRole: "platform_ops" }, requiredInputs: ["canonical_product_id"], confirmation: "interactive_confirmation" } }] as CanonicalProductConsistencyReport["findings"], orphanFindings: [] }} />);
    expect(markup).toContain("listing / 1 task / 1 publish");
    expect(markup).toContain("2026-08-31T01:02:03.000Z");
    expect(markup).toContain("补齐规范商品映射（需要 platform_ops 权限）");
  });

  it("distinguishes unavailable data from a real empty result and never claims clean", () => {
    const markup = renderToStaticMarkup(<CanonicalConsistencySummary report={{ workspaceId: "ws-1", status: "clean", availability: "unavailable", contractStatus: "unavailable", counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 0 }, findings: [], orphanFindings: [] }} />);
    expect(markup).toContain("一致性数据暂不可读取");
    expect(markup).toContain("没有可验证的商品记录");
    expect(markup).not.toContain("链路正常");
  });
});
