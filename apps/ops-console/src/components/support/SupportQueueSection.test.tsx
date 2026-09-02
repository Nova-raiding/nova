import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SupportDomainModel } from "../../hooks/useSupportDomain.js";
import { SupportQueueSection } from "./SupportQueueSection.js";

function model(overrides: Partial<SupportDomainModel> = {}): SupportDomainModel {
  return {
    workspaceId: "ws_1", tickets: [], filters: { query: "" }, loading: false, loadingMore: false,
    detailLoading: false, mutating: false, error: "", hasMore: false, setFilters: vi.fn(), reload: vi.fn(),
    loadMore: vi.fn(), selectTicket: vi.fn(), clearSelection: vi.fn(), create: vi.fn(), assign: vi.fn(),
    transition: vi.fn(), comment: vi.fn(), exportCrm: vi.fn(), reportLoading: false, loadReport: vi.fn(), ...overrides,
  };
}

describe("SupportQueueSection error recovery", () => {
  it("announces an initial load failure and provides a keyboard-reachable refresh", () => {
    const html = renderToStaticMarkup(<SupportQueueSection model={model({ error: "权限已失效" })} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("工单队列读取失败");
    expect(html).toContain("当前空列表不代表没有工单");
    expect(html).toContain('aria-label="刷新工单"');
  });

  it("keeps the recovery message explicit while preserving previously loaded tickets", () => {
    const html = renderToStaticMarkup(<SupportQueueSection model={model({ error: "运营 API 暂时不可用", tickets: [{
      id: "ticket_1", workspaceId: "ws_1", ticketNumber: "SUP-001", subject: "支付异常", description: "客户付款未到账",
      status: "open", priority: "urgent", customerId: "customer_1", customerName: "云朵商家", tags: [], revision: 1,
      sla: {
        policy: { version: 1, calendar: "business_weekday_utc", firstResponseMinutes: 120, resolutionMinutes: 480 },
        firstResponseDueAt: "2026-08-31T11:00:00.000Z", resolutionDueAt: "2026-09-01T17:00:00.000Z", pausedMinutes: 0, state: "on_track",
      },
      assignedTo: undefined, createdBy: "support_1", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z",
    }]} )} />);
    expect(html).toContain("已保留上一次成功读取的工单");
    expect(html).toContain("SUP-001");
    expect(html).toContain("刷新工单");
  });
});
