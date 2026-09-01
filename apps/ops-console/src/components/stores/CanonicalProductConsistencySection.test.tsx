import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CanonicalProductConsistencySection, CanonicalRelationChain } from "./CanonicalProductConsistencySection.js";
import type { CanonicalProductConsistencyReport } from "../../types/ops.js";

const report: CanonicalProductConsistencyReport = {
  workspaceId: "ws-1", status: "attention_required",
  counts: { verified: 1, legacy_only: 1, conflict: 1, blocked: 0 },
  findings: [
    { legacyProductId: "product-legacy", productId: "product-legacy", status: "legacy_only", codes: ["CANONICAL_MAPPING_MISSING"], listingIds: [], campaignItemIds: [], taskIds: [], publishJobIds: [], scope: { brandId: "brand-1", platform: "taobao", accountId: "store-1", listingId: null }, evidence: { codes: ["CANONICAL_MAPPING_MISSING"], generatedAt: "2026-08-31T00:00:00.000Z", revision: "rev-1" }, blocking: { code: "CANONICAL_MAPPING_MISSING", message: "映射缺失", impact: "不能继续发布", objectType: "product", objectId: "product-legacy", retryable: true }, nextAction: { id: "map", method: "canonical.product.consistency", label: "补齐规范商品映射", reason: "关系缺失", permission: { allowed: false, requiredRole: "platform_ops" }, requiredInputs: [], confirmation: "none" } },
    { legacyProductId: "product-ok", status: "verified", codes: [], canonicalProductId: "canonical-1", listingIds: ["listing-1"], campaignItemIds: [], taskIds: ["task-1"], publishJobIds: [] },
    { legacyProductId: "product-conflict", status: "conflict", codes: ["CANONICAL_MAPPING_AMBIGUOUS"], listingIds: [], campaignItemIds: [], taskIds: [], publishJobIds: [] },
  ], orphanFindings: [],
};

describe("CanonicalProductConsistencySection", () => {
  it("restores keyboard focus to the detail trigger after either drawer closes", () => {
    const source = readFileSync(fileURLToPath(new URL("./CanonicalProductConsistencySection.tsx", import.meta.url)), "utf8");
    expect(source).toContain("selectedTriggerRef.current = event.currentTarget");
    expect(source).toContain("selectedOrphanTriggerRef.current = event.currentTarget");
    expect(source).toContain("window.requestAnimationFrame(() => selectedTriggerRef.current?.focus({ preventScroll: true }))");
    expect(source).toContain("window.requestAnimationFrame(() => selectedOrphanTriggerRef.current?.focus({ preventScroll: true }))");
  });

  it("does not offer a recheck action without canonical evidence read permission", () => {
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection canRead={false} />);
    expect(markup).toContain("当前会话无权读取一致性证据");
    expect(markup).toContain("不是空结果");
    expect(markup).not.toMatch(/>重新检查<\/button>/u);
  });

  it("marks an in-flight recheck as checking instead of preserving a stale success state", () => {
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection report={report} loading />);
    expect(markup).toContain("检查中");
    expect(markup).toContain("旧报告暂不作为当前结论");
    expect(markup).toContain("ant-tag-processing");
  });

  it("does not turn missing reports into a green state", () => {
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection />);
    expect(markup).toContain("暂无可验证的一致性报告");
    expect(markup).not.toContain("已验证");
  });

  it("renders status counts, blocking explanation and an accessible details action", () => {
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection report={report} onRefresh={vi.fn()} />);
    expect(markup).toContain("规范商品一致性");
    expect(markup).toContain("存在未验证关系");
    expect(markup).toContain("仅旧商品");
    expect(markup).toContain("product-legacy");
    expect(markup).toContain("查看 product-legacy 一致性详情");
    expect(markup).toContain("补齐规范商品映射（需要 platform_ops 权限）");
    expect(markup).toContain("证据时间");
    expect(markup).toContain("2026-08-31T00:00:00.000Z");
    expect(markup).toContain("未找到规范商品映射");
    expect(markup).toContain('id="canonical-consistency-error-summary"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-labelledby="canonical-consistency-error-summary-label"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('canonical-consistency-card');
    expect(markup).toContain('canonical-consistency-filter');
    expect(markup).toContain('canonical-consistency-action');
  });

  it("renders every relationship segment and makes missing links explicit", () => {
    const markup = renderToStaticMarkup(<CanonicalRelationChain finding={report.findings[0]!} />);
    expect(markup).toContain('aria-label="商品关系链"');
    expect(markup).toContain("旧商品");
    expect(markup).toContain("规范商品");
    expect(markup).toContain("Listing");
    expect(markup).toContain("未返回关系");
    expect(markup).toContain("brand-1 / taobao / store-1");
  });

  it("makes blocked detail evidence focusable and announced", () => {
    const source = readFileSync(fileURLToPath(new URL("./CanonicalProductConsistencySection.tsx", import.meta.url)), "utf8");
    expect(source).toContain('id="canonical-detail-error-summary"');
    expect(source).toContain('aria-labelledby="canonical-detail-error-summary-label"');
    expect(source).toContain("detailErrorSummaryRef.current?.focus({ preventScroll: true })");
    expect(source).toContain('id="canonical-orphan-detail-error-summary"');
    expect(source).toContain('aria-live="assertive"');
  });

  it("exposes a keyboard focus target and recovery guidance for report errors", () => {
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection report={{ ...report, findings: [], orphanFindings: [], error: { code: "CONSISTENCY_READ_FAILED", message: "读取失败" }, contractStatus: "unavailable", availability: "unavailable" }} onRefresh={vi.fn()} />);
    expect(markup).toContain('id="canonical-consistency-error-summary"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("CONSISTENCY_READ_FAILED");
    expect(markup).toContain("错误状态不会自动放行后续操作");
    expect(markup).toContain('aria-label="重试一致性报告"');
    expect(markup).toContain('aria-label="重新检查一致性数据"');
  });

  it("renders orphan relation objects instead of hiding them in the blocked count", () => {
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection report={{ ...report, orphanFindings: [{ entityType: "listing", entityId: "orphan-listing-1", status: "blocked", codes: ["LISTING_CANONICAL_ORPHAN"] }] }} />);
    expect(markup).toContain("未挂接关系对象");
    expect(markup).toContain("orphan-listing-1");
    expect(markup).toContain("查看 orphan-listing-1 关系详情");
    expect(markup).toContain("LISTING_CANONICAL_ORPHAN");
  });

  it("does not present stale or unknown reports as verified", () => {
    const stale = renderToStaticMarkup(<CanonicalProductConsistencySection report={{ ...report, status: "clean", counts: { verified: 1, legacy_only: 0, conflict: 0, blocked: 0 }, findings: [report.findings[1]!], freshness: "stale" }} />);
    expect(stale).toContain("需处理");
    expect(stale).not.toContain("<span class=\"ant-tag ant-tag-success\">已验证</span>");
    expect(stale).toContain('role="alert"');
  });

  it("distinguishes unavailable data from a real empty result", () => {
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection report={{ ...report, status: "attention_required", contractStatus: "unavailable", availability: "unavailable", findings: [], orphanFindings: [], counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 0 } }} onRefresh={vi.fn()} />);
    expect(markup).toContain("一致性数据暂不可读取");
    expect(markup).toContain("这不是零结果");
    expect(markup).toContain("重新检查");
    expect(markup).not.toContain("关系链已验证");
  });

  it("renders the server next_action contract without inventing a repair action", () => {
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection report={{ ...report, findings: [{ ...report.findings[0]!, nextAction: { ...report.findings[0]!.nextAction!, permission: { allowed: true, requiredRole: null }, requiredInputs: ["canonical_product_id"], confirmation: "interactive_confirmation" } }] }} />);
    expect(markup).toContain("canonical.product.consistency");
    expect(markup).toContain("关系缺失");
    expect(markup).toContain("输入：canonical_product_id");
    expect(markup).toContain("需要交互确认");
    expect(markup).toContain("补齐规范商品映射（待接入）");
    expect(markup).toContain('aria-disabled="true"');
  });

  it("distinguishes a server-confirmed empty result from a filtered empty result", () => {
    const emptyReport = { ...report, status: "clean" as const, counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 0 }, findings: [], orphanFindings: [], freshness: "fresh" as const };
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection report={emptyReport} />);
    expect(markup).toContain("当前没有关系问题");
    expect(markup).toContain("这不是客户端未加载");
    expect(markup).not.toContain("当前筛选没有商品");
  });

  it("gives report recovery controls a specific accessible name", () => {
    const markup = renderToStaticMarkup(<CanonicalProductConsistencySection onRefresh={vi.fn()} />);
    expect(markup).toContain('aria-label="重新检查一致性报告"');
  });
});
