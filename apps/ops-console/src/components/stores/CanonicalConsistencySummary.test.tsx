import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanonicalConsistencySummary } from "./CanonicalConsistencySummary.js";

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
});
