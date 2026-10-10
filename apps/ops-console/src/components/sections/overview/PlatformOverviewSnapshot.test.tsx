import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { PlatformModelUsageSummary, WorkspaceDirectoryPage } from "../../../types/ops";
import { PlatformOverviewSnapshot } from "./PlatformOverviewSnapshot.js";

/** The unresolved directory as the hook seeds it: no measured count at all. */
const unresolvedDirectory: WorkspaceDirectoryPage = { items: [], offset: 0, limit: 20, hasMore: false };

const model = (overrides: Record<string, unknown> = {}) => ({
  workspaceDirectory: { total: 0, merchantWorkspaceCount: 0, activeMemberWorkspaceCount: 0 },
  platformFinanceSummary: undefined,
  platformMonthlyFinanceSummary: undefined,
  platformMonthlyFinanceMonth: "2026年9月",
  platformCommercialCatalog: [],
  platformModelUsageSummary: undefined,
  dataSetError: () => undefined,
  ...overrides,
}) as unknown as OpsConsoleModel;

const usage = (overrides: Partial<PlatformModelUsageSummary> = {}): PlatformModelUsageSummary => ({
  scope: "platform",
  workspaceCount: 1,
  failedWorkspaceCount: 0,
  recordCount: 1,
  totalTokens: 48_213_905,
  providerCostCny: 12.34,
  customerChargeCny: 0,
  unsettledRecordCount: 0,
  byModality: {},
  byModel: {},
  bySettlementStatus: {},
  ...overrides,
});

/**
 * The rendered value + unit of one dashboard tile, sliced from its label.
 *
 * The lookup is anchored on the label's own closing tag: a bare
 * `html.indexOf(label)` matched the first *substring*, so 「平台消耗金额」
 * resolved to the earlier 「累计平台消耗金额」 tile and the monthly assertion
 * silently re-checked the cumulative one.
 */
const tile = (html: string, label: string) => {
  const marker = `>${label}</span>`;
  const start = html.indexOf(marker);
  expect(start, `tile ${label} is missing`).toBeGreaterThan(-1);
  return html.slice(start + marker.length, html.indexOf("</strong>", start));
};

const render = (overrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<PlatformOverviewSnapshot model={model(overrides)} onNavigate={() => undefined} />);

describe("PlatformOverviewSnapshot money honesty", () => {
  it("never renders totalTokens as a CNY amount", () => {
    const html = render({ platformModelUsageSummary: usage({ providerCostStatus: "verified" }) });
    expect(html).not.toContain("48213905");
    expect(tile(html, "累计平台消耗金额")).toContain("12.34");
    expect(tile(html, "平台消耗金额")).toContain("—");
  });

  it("resolves the monthly tile from its own label, not from an earlier substring match", () => {
    // Direct proof of the anchored lookup: the cumulative label contains the
    // monthly one as a substring, and the two tiles carry different values.
    const synthetic = '<article><span class="l">累计平台消耗金额</span><strong>99 <small>元</small></strong></article>'
      + '<article><span class="l">平台消耗金额</span><strong>7 <small>元</small></strong></article>';
    expect(tile(synthetic, "平台消耗金额")).toContain("7");
    expect(tile(synthetic, "平台消耗金额")).not.toContain("99");
    expect(tile(synthetic, "累计平台消耗金额")).toContain("99");
  });

  it("shows an explicit unknown when provider cost evidence is not verified", () => {
    // `providerCostStatus: "partial"` means the server could not evidence the
    // cost. Showing the number anyway would state an unverified cost as fact.
    const html = render({ platformModelUsageSummary: usage({ providerCostStatus: "partial" }) });
    expect(tile(html, "累计平台消耗金额")).not.toContain("12.34");
    expect(tile(html, "累计平台消耗金额")).toContain("—");
    expect(html).not.toContain("48213905");
  });

  it("renders verified whole-yuan provider cost without screenshot-mismatching decimal zeroes", () => {
    const html = render({ platformModelUsageSummary: usage({ providerCostCny: 0, providerCostStatus: "verified" }) });
    expect(tile(html, "累计平台消耗金额")).toContain("0 ");
    expect(tile(html, "累计平台消耗金额")).not.toContain("0.00");
  });

  it("does not present an absent finance, usage or directory read as a measured zero", () => {
    const html = render({ workspaceDirectory: unresolvedDirectory });
    expect(tile(html, "接入费总收入")).toContain("<small>元</small>");
    expect(tile(html, "接入费总收入")).toContain("—");
    expect(tile(html, "接入费销售额")).toContain("—");
    expect(tile(html, "套餐销售额")).toContain("—");
    expect(tile(html, "已关联商家工作区")).toContain("—");
    expect(tile(html, "有活跃成员的工作区")).toContain("—");
    expect(tile(html, "累计平台消耗金额")).toContain("—");
  });

  it("does not show stale dashboard values after a dataset refresh failure", () => {
    const html = render({
      workspaceDirectory: { total: 12, merchantWorkspaceCount: 9, items: [], offset: 0, limit: 20, hasMore: false },
      platformFinanceSummary: { onboardingOrderCny: 900, subscriptionOrderCny: 1200, subscriptionOrderWorkspaceCount: 4 },
      platformModelUsageSummary: usage({ providerCostStatus: "verified" }),
      dataSetError: (method: string) => method === "ops.workspaces.list" || method === "ops.finance.search" || method === "ops.model-usage.summary" ? "refresh failed" : undefined,
    });
    expect(tile(html, "已关联商家工作区")).toContain("—");
    expect(tile(html, "接入费总收入")).toContain("—");
    expect(tile(html, "套餐销售额")).toContain("—");
    expect(tile(html, "累计平台消耗金额")).toContain("—");
  });

  it("never renders an unresolved directory as a measured customer count", () => {
    // Nothing has been read from `ops.workspaces.list`, so no count exists.
    // The seed the hook actually installs is pinned in
    // `src/hooks/useOpsConsoleModel.test.ts`.
    const html = render({ workspaceDirectory: unresolvedDirectory });
    expect(tile(html, "已关联商家工作区")).toContain("—");
    expect(tile(html, "已关联商家工作区")).not.toMatch(/\d/u);
    expect(tile(html, "有活跃成员的工作区")).toContain("—");
  });

  it("still renders a genuine measured zero as zero", () => {
    // The unknown state must not swallow real data: a directory that reports
    // zero customers is measured, and must read as 0 rather than "—".
    const html = render({ workspaceDirectory: { total: 0, merchantWorkspaceCount: 0, activeMemberWorkspaceCount: 0, items: [], offset: 0, limit: 20, hasMore: false } });
    expect(tile(html, "已关联商家工作区")).toContain("0");
    expect(tile(html, "有活跃成员的工作区")).toContain("0");
  });

  it("does not invent a gifted-customer count the server never returned", () => {
    // `total - merchantWorkspaceCount` was a derived number presented as a
    // measurement; the directory query carries no gifted semantics at all.
    const html = render({ workspaceDirectory: { total: 3, merchantWorkspaceCount: 3, activeMemberWorkspaceCount: 2, items: [], offset: 0, limit: 20, hasMore: false } });
    expect(tile(html, "已关联商家工作区")).toContain("3");
    expect(tile(html, "有活跃成员的工作区")).toContain("2");
    expect(tile(html, "赠送客户数")).toContain("—");
    expect(tile(html, "赠送客户数")).not.toMatch(/\d/u);
  });

  it("separates cumulative finance from the current Shanghai-month window", () => {
    const html = render({ platformFinanceSummary: {
      onboardingOrderCny: 1288,
      subscriptionOrderCny: 3200,
      subscriptionOrderBySku: { basic: { orderCount: 2 }, growth: { orderCount: 3 } },
    }, platformMonthlyFinanceSummary: {
      onboardingOrderCny: 88,
      onboardingOrderWorkspaceCount: 2,
      subscriptionOrderCny: 400,
      subscriptionOrderBySku: {
        basic: { orderCount: 1, workspaceCount: 1 },
        growth: { orderCount: 2, workspaceCount: 1 },
        custom_bundle: { orderCount: 4, workspaceCount: 2 },
      },
      commercialOrderBySku: {
        basic: { orderCount: 1, workspaceCount: 1 },
        growth: { orderCount: 2, workspaceCount: 1 },
        custom_bundle: { orderCount: 4, workspaceCount: 2 },
        "sku-monthly-basic": { orderCount: 1, workspaceCount: 1 },
        "sku-monthly-growth": { orderCount: 2, workspaceCount: 1 },
        "sku-monthly-custom": { orderCount: 4, workspaceCount: 2 },
      },
    }, platformCommercialCatalog: [
      { skuCode: "sku-monthly-basic", name: "基础版", type: "monthly" },
      { skuCode: "sku-monthly-growth", name: "成长版", type: "monthly" },
      { skuCode: "sku-monthly-custom", name: "定制方案", type: "monthly" },
      { skuCode: "sku-points-500", name: "点数充值", type: "point_pack" },
    ] });
    expect(html).toContain("9月经营数据");
    expect(html).toContain("当前月份：<strong>9月</strong>");
    expect(html).toContain("<small>本月</small>");
    expect(tile(html, "接入费销售额")).toContain("88");
    expect(tile(html, "套餐销售额")).toContain("400");
    expect(tile(html, "接入费总收入")).toContain("1288");
    expect(tile(html, "套餐销量")).toContain("7");
    expect(tile(html, "2000 版本销量")).toContain("1");
    expect(tile(html, "5000 版本销量")).toContain("2");
    expect(html).not.toContain("定制方案 销量");
    expect(tile(html, "接入客户数")).toContain("2");
    expect(tile(html, "套餐销售额")).not.toContain("3200");
    expect(html).toContain("跨月付款仍按订单创建月份归类");
    expect(tile(html, "平台消耗金额")).toContain("—");
  });

  it("preserves a real zero when the monthly finance summary reports no bundle orders", () => {
    const html = render({ platformMonthlyFinanceSummary: {
      subscriptionOrderCny: 0,
      subscriptionOrderBySku: {},
      commercialOrderBySku: {},
    } });
    expect(tile(html, "套餐销量")).toContain("0");
    expect(tile(html, "套餐销售额")).toContain("0");
    expect(tile(html, "2000 版本销量")).toContain("—");
    expect(tile(html, "5000 版本销量")).toContain("—");
  });

  it("counts monthly SKUs from the commercial summary and excludes point packs", () => {
    const html = render({ platformMonthlyFinanceSummary: {
      subscriptionOrderCny: 400,
      subscriptionOrderBySku: {},
      commercialOrderBySku: {
        "sku-monthly-basic": { orderCount: 2, workspaceCount: 1 },
        "sku-monthly-growth": { orderCount: 1, workspaceCount: 1 },
        "sku-points-500": { orderCount: 7, workspaceCount: 3 },
      },
    }, platformCommercialCatalog: [
      { skuCode: "sku-monthly-basic", name: "基础版", type: "monthly" },
      { skuCode: "sku-monthly-growth", name: "成长版", type: "monthly" },
      { skuCode: "sku-points-500", name: "点数充值", type: "point_pack" },
    ] });
    expect(tile(html, "套餐销量")).toContain("3");
    expect(tile(html, "套餐销量")).not.toContain("10");
    expect(tile(html, "2000 版本销量")).toContain("2");
    expect(tile(html, "5000 版本销量")).toContain("1");
  });

  it("never fabricates a zero for the creative-point tiles that have no data source", () => {
    const html = render({ platformModelUsageSummary: usage({ providerCostStatus: "verified" }) });
    for (const label of ["累计客户消耗创意点", "客户消耗创意点", "额外创意点充值"]) {
      expect(tile(html, label), label).toContain("—");
      expect(tile(html, label), label).not.toMatch(/\d/u);
    }
  });

  it("does not map unsupported subscription workspace counts onto customer counts", () => {
    const html = render({
      workspaceDirectory: { total: 18, merchantWorkspaceCount: 18, activeMemberWorkspaceCount: 15, items: [], offset: 0, limit: 20, hasMore: false },
      platformMonthlyFinanceSummary: {
        onboardingOrderWorkspaceCount: 9,
        onboardingOrderCount: 13,
        subscriptionOrderWorkspaceCount: 7,
      },
    });
    expect(tile(html, "已关联商家工作区")).toContain("18");
    expect(tile(html, "有活跃成员的工作区")).toContain("15");
    expect(tile(html, "接入客户数")).toContain("9");
    expect(tile(html, "接入费销售额")).toContain("—");
    expect(tile(html, "套餐销量")).toContain("—");
    expect(tile(html, "累计客户消耗创意点")).toContain("—");
  });
});
