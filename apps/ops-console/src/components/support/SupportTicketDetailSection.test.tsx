import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupportDomainModel } from "../../hooks/useSupportDomain.js";
import { SupportTicketDetailSection } from "./SupportTicketDetailSection.js";

function model(overrides: Partial<SupportDomainModel> = {}): SupportDomainModel {
  return {
    workspaceId: "ws_1", tickets: [], filters: { query: "" }, loading: false, loadingMore: false,
    detailLoading: false, mutating: false, error: "", hasMore: false, setFilters: vi.fn(), reload: vi.fn(),
    loadMore: vi.fn(), selectTicket: vi.fn(), clearSelection: vi.fn(), create: vi.fn(), assign: vi.fn(),
    transition: vi.fn(), comment: vi.fn(), exportCrm: vi.fn(), reportLoading: false, loadReport: vi.fn(), ...overrides,
  };
}

describe("SupportTicketDetailSection", () => {
  it("renders an accessible empty state before a ticket is selected", () => {
    const html = renderToStaticMarkup(<SupportTicketDetailSection model={model()} />);
    expect(html).toContain("从工单队列中选择一项");
  });

  it("presents immutable event history and optimistic revision", () => {
    const html = renderToStaticMarkup(<SupportTicketDetailSection model={model({
      selected: {
        ticket: {
          id: "ticket_1", workspaceId: "ws_1", ticketNumber: "SUP-001", subject: "支付异常", description: "客户付款未到账",
          status: "in_progress", priority: "urgent", customerId: "customer_1", customerName: "云朵商家", tags: [], revision: 2,
          assignedTo: "support_2", createdBy: "support_1", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:01:00.000Z",
          sla: { policy: { version: 1, calendar: "business_weekday_utc", firstResponseMinutes: 120, resolutionMinutes: 480 }, firstResponseDueAt: "2026-08-31T11:00:00.000Z", resolutionDueAt: "2026-09-01T17:00:00.000Z", pausedMinutes: 0, state: "on_track" },
        },
        events: [{
          id: "event_1", workspaceId: "ws_1", ticketId: "ticket_1", sequence: 1, eventType: "created", actorId: "support_1",
          idempotencyKey: "create-ticket-001", payload: { status: "open" }, createdAt: "2026-08-29T00:00:00.000Z",
        }],
      },
    })} />);
    expect(html).toContain("不可变事件历史");
    expect(html).toContain("版本 2");
    expect(html).toContain("创建工单 · #1");
  });
});
