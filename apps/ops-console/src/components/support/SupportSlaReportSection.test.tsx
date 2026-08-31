import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupportDomainModel } from "../../hooks/useSupportDomain.js";
import { SupportSlaReportSection } from "./SupportSlaReportSection.js";

const base = (): SupportDomainModel => ({ workspaceId: "ws_1", tickets: [], filters: { query: "" }, loading: false, loadingMore: false, detailLoading: false, mutating: false, error: "", hasMore: false, setFilters: vi.fn(), reload: vi.fn(), loadMore: vi.fn(), selectTicket: vi.fn(), clearSelection: vi.fn(), create: vi.fn(), assign: vi.fn(), transition: vi.fn(), comment: vi.fn(), exportCrm: vi.fn(), reportLoading: false, loadReport: vi.fn() });

describe("SupportSlaReportSection", () => {
  it("explains the empty state without implying zero performance", () => {
    expect(renderToStaticMarkup(<SupportSlaReportSection model={base()} />)).toContain("尚未生成月报");
  });

  it("renders server-provided metrics and immutable evidence", () => {
    const html = renderToStaticMarkup(<SupportSlaReportSection model={{ ...base(), report: { reportId: "run_1", workspaceId: "ws_1", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", cutoffAt: "2026-09-03T00:00:00.000Z", policyVersions: [1], calendarVersions: ["business_weekday_utc"], denominator: 2, met: 1, failed: 1, excluded: 1, lateOrUnresolved: 1, checksum: "a".repeat(64), ticketResults: [] } }} />);
    expect(html).toContain("50.0%");
    expect(html).toContain("历史报告为不可变证据");
  });
});
