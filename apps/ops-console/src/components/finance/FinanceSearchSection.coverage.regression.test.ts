import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FinanceSearchController } from "../../hooks/useFinanceSearch.js";
import { FinanceSearchSection } from "./FinanceSearchSection.js";

const controller = (nextCursor?: string, totalRecords = 47): FinanceSearchController => ({
  query: { limit: 20 },
  page: {
    records: [],
    summary: {
      totalRecords,
      rechargeOrderCny: 0,
      subscriptionOrderCny: 0,
      subscriptionOrderWorkspaceCount: 0,
      subscriptionOrderBySku: {},
      walletCreditCny: 0,
      walletDebitCny: 0,
      walletNetCny: 0,
      providerCostCny: 0,
      customerChargeCny: 0,
      usageUnits: 0,
      byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 },
    },
    ...(nextCursor ? { nextCursor } : {}),
    snapshotAt: "2026-10-10T00:00:00.000Z",
    scope: { role: "platform_ops", workspaceCount: 2 },
  },
  records: [], resultsStale: false, loading: false, loadingMore: false, detailLoading: false, exporting: false,
  search: vi.fn(async () => undefined), loadMore: vi.fn(async () => undefined), openDetail: vi.fn(async () => undefined),
  retryDetail: vi.fn(async () => undefined), closeDetail: vi.fn(), downloadCsv: vi.fn(async () => undefined),
});

const render = (value: FinanceSearchController) => renderToStaticMarkup(createElement(FinanceSearchSection, { controller: value }));

describe("FinanceSearchSection result coverage", () => {
  it("states that matching finance records remain unloaded when a cursor exists", () => {
    const html = render(controller("finance-next"));
    expect(html).toContain("已展示 0 条，共 47 条匹配记录。还有未加载记录。");
    expect(html).toContain("加载更多财务记录");
  });

  it("states when all matching finance records have been loaded", () => {
    const html = render(controller(undefined, 0));
    expect(html).toContain("已展示 0 条，共 0 条匹配记录。已加载全部匹配记录。");
    expect(html).not.toContain("加载更多财务记录");
  });
});
