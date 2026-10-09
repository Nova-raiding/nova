import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CommercialOperationsController } from "../../hooks/useCommercialOperations.js";
import { commercialTimelineDateBoundary, commercialTimelineHasFilters, commercialTimelineMatchesDateRange, TimelineTable } from "./CommercialOperationsWorkspace.js";

describe("commercial timeline controls", () => {
  it("interprets date-only filters in the browser's local calendar", () => {
    const localStart = new Date(2026, 9, 9, 0, 0, 0, 0).getTime();
    const localEnd = new Date(2026, 9, 9, 23, 59, 59, 999).getTime();
    expect(commercialTimelineDateBoundary("2026-10-09")).toBe(localStart);
    expect(commercialTimelineDateBoundary("2026-10-09", true)).toBe(localEnd);
    expect(commercialTimelineMatchesDateRange(new Date(2026, 9, 9, 0, 30).toISOString(), "2026-10-09", "2026-10-09")).toBe(true);
    expect(commercialTimelineMatchesDateRange(new Date(2026, 9, 10, 0, 0).toISOString(), "2026-10-09", "2026-10-09")).toBe(false);
    expect(commercialTimelineDateBoundary("2026-02-30")).toBeUndefined();
  });

  it("treats date-only constraints as active filters for the empty state", () => {
    expect(commercialTimelineHasFilters({ query: "", status: "" }, "2026-10-09", "")).toBe(true);
    expect(commercialTimelineHasFilters({ query: "", status: "" }, "", "")).toBe(false);
  });

  it("shows truncation and a cursor continuation action while retaining loaded rows", () => {
    const controller = {
      query: { view: "timeline", record: "", status: "", query: "", page: 1, sort: "", order: "" },
      setQuery: vi.fn(), targetWorkspaceId: "ws-1", loadView: vi.fn(), loadMoreTimeline: vi.fn(), timelineLoadingMore: false,
    } as unknown as CommercialOperationsController;
    const state = { status: "ready", data: {
      total: 101, truncated: true, sourceTruncated: true, nextCursor: "cursor-next", items: [{
        id: "audit-1", workspaceId: "ws-1", kind: "audit.read", status: "audited", occurredAt: "2026-10-09T01:00:00.000Z",
        operationId: null, traceId: null, requestId: null, actorId: "operator", reason: null, resourceId: "resource-1", evidence: {},
      }],
    } } as const;
    const html = renderToStaticMarkup(<TimelineTable state={state as never} controller={controller} />);
    expect(html).toContain("服务端仍有未加载记录");
    expect(html).toContain("时间线来源达到单源读取上限，当前聚合可能不完整");
    expect(html).toContain("加载更多商业时间线事件");
    expect(html).toContain("audit-1");
  });
});
