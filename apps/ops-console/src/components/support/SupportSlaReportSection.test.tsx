import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupportDomainModel } from "../../hooks/useSupportDomain.js";
import { SupportSlaReportSection, supportSlaActionErrorMessage } from "./SupportSlaReportSection.js";

const base = (): SupportDomainModel => ({ workspaceId: "ws_1", tickets: [], filters: { query: "" }, loading: false, loadingMore: false, detailLoading: false, mutating: false, error: "", hasMore: false, setFilters: vi.fn(), reload: vi.fn(), loadMore: vi.fn(), selectTicket: vi.fn(), clearSelection: vi.fn(), create: vi.fn(), assign: vi.fn(), transition: vi.fn(), comment: vi.fn(), reportLoading: false, loadReport: vi.fn() });

describe("SupportSlaReportSection", () => {
  it("explains the empty state without implying zero performance", () => {
    expect(renderToStaticMarkup(<SupportSlaReportSection model={base()} />)).toContain("尚未生成月报");
  });

  it("renders server-provided metrics and immutable evidence", () => {
    const html = renderToStaticMarkup(<SupportSlaReportSection model={{ ...base(), report: { reportId: "run_1", workspaceId: "ws_1", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", cutoffAt: "2026-09-03T00:00:00.000Z", policyVersions: [1], calendarVersions: ["business_weekday_utc"], denominator: 2, met: 1, failed: 1, excluded: 1, lateOrUnresolved: 1, checksum: "a".repeat(64), ticketResults: [] } }} />);
    expect(html).toContain("50.0%");
    expect(html).toContain("历史报告为不可变证据");
  });

  it("marks the prior-period snapshot stale during a cross-period refresh and disables correction", () => {
    const html = renderToStaticMarkup(<SupportSlaReportSection model={{
      ...base(), reportLoading: true, reportStale: true,
      report: { reportId: "august", workspaceId: "ws_1", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", cutoffAt: "2026-09-03T00:00:00.000Z", policyVersions: [1], calendarVersions: ["business_weekday_utc"], denominator: 1, met: 1, failed: 0, excluded: 0, lateOrUnresolved: 0, checksum: "b".repeat(64), ticketResults: [] },
    }} />);
    expect(html).toContain("月报正在刷新或工作区切换，当前显示的是历史快照");
    expect(html).toMatch(/<button(?=[^>]*disabled="")[^>]*><span>创建 correction<\/span><\/button>/);
  });

  it("keeps the old snapshot visible but marks failed refreshes stale and correction unavailable", () => {
    const html = renderToStaticMarkup(<SupportSlaReportSection model={{
      ...base(), reportLoading: false, reportStale: true, reportError: "服务端生成失败",
      report: { reportId: "old", workspaceId: "ws_1", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", cutoffAt: "2026-09-03T00:00:00.000Z", policyVersions: [1], calendarVersions: ["business_weekday_utc"], denominator: 1, met: 1, failed: 0, excluded: 0, lateOrUnresolved: 0, checksum: "c".repeat(64), ticketResults: [] },
    }} />);
    expect(html).toContain("月报刷新失败，当前显示的是历史快照");
    expect(html).toContain("服务端生成失败");
    expect(html).toMatch(/<button(?=[^>]*disabled="")[^>]*><span>创建 correction<\/span><\/button>/);
  });

  it("fails closed for a report snapshot from the previous workspace during a scope switch", () => {
    const html = renderToStaticMarkup(<SupportSlaReportSection model={{
      ...base(), workspaceId: "ws_new",
      report: { reportId: "ws_old_report", workspaceId: "ws_old", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", cutoffAt: "2026-09-03T00:00:00.000Z", policyVersions: [1], calendarVersions: ["business_weekday_utc"], denominator: 1, met: 1, failed: 0, excluded: 0, lateOrUnresolved: 0, checksum: "d".repeat(64), ticketResults: [] },
    }} />);
    expect(html).toContain("工作区已切换；旧工作区月报已隐藏");
    expect(html).not.toContain("SLA 达成率");
    expect(html).not.toContain("统计分母");
    expect(html).not.toContain("报告 checksum：" + "d".repeat(64));
    expect(html).not.toContain("8/1/2026");
  });

  it("keeps actionable errors user-facing and preserves a retryable message", () => {
    expect(supportSlaActionErrorMessage(new Error("权限不足"))).toBe("权限不足");
    expect(supportSlaActionErrorMessage({})).toBe("提交失败，请检查网络或权限后重试。");
    expect(SupportSlaReportSection.toString()).toContain("重试提交");
    const source = SupportSlaReportSection.toString();
    expect(source).toContain("原窗口仍保持打开，已填写的理由不会清空");
    expect(source).toContain('"aria-live": "assertive"');
    expect(source).toContain("minHeight: 44");
    expect(source).toContain('"aria-busy": model.correctionLoading || undefined');
    expect(source).toContain("model.correctionLoading");
  });
});

/**
 * Guard for the SLA-correction decide control's approval transport.
 *
 * The `approval` obligation on `ops.support.sla.correction.decide` is resolved
 * server-side from the token grant alone (`verifiedApprovalActor` in
 * apps/api/src/server.ts). The section previously rendered 批准/拒绝 with no
 * token input anywhere in the file — it had a transport (`OpsRpcOptions` on
 * `opsDomainClients.decideCorrection`) but no producer, so under
 * `requiresStrictAuth()` it could only ever fail. These assertions read the
 * real file contents, in the source-scanning style of
 * `RuleCenterSection.test.tsx`, and pin the send path through the hook as well
 * as the presence of the input.
 */
describe("SLA correction approval transport", () => {
  const source = readFileSync(new URL("./SupportSlaReportSection.tsx", import.meta.url), "utf8");
  const modelSource = readFileSync(new URL("../../hooks/useSupportDomain.ts", import.meta.url), "utf8");

  it("demands the approver's token instead of implying a typed name authorises", () => {
    expect(source).toContain("Input.Password");
    expect(source).toContain('autoComplete="off"');
    expect(source).toContain('aria-label="审批人令牌"');
    expect(source).toContain("由审批人提供的令牌");
    expect(source).toContain("审批证据来自审批人令牌");
    // The approver supplies the grant, not the operator: the copy must say so.
    expect(source).toContain("令牌由审批人本人提供，不由操作者代填");
    expect(source).toContain("审批成功后自动清空");
    // A bearer credential must not outlive the submit it accompanied, and must
    // never reach browser storage.
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).toContain('setApprovalToken("")');
  });

  it("sends the token on every decide path and keeps it out of the rpc params", () => {
    // Both the confirm (onOk) and the retry control must carry the same
    // evidence; a retry that dropped the token would re-fail under strict auth.
    const calls = source.match(/model\.decideCorrection\(decisionOpen, reason, approvalToken\)/gu) ?? [];
    expect(calls).toHaveLength(2);
    // Required for submit, so the operator learns before filling in a reason.
    expect(source).toContain("!approvalToken.trim()");
    // The hook bridges the model parameter onto OpsRpcOptions, which is what
    // becomes the x-authorization-approval-token header; a param field would
    // recreate the forgeable caller-supplied approver claim.
    expect(modelSource).toContain("}, { authorizationApprovalToken: approvalToken?.trim() })");
    expect(modelSource).toContain("report.workspaceId !== workspaceId");
    expect(modelSource).toContain("approvalToken?: string) => Promise<void>");
  });
});
