import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { PlatformModelUsageSummary, WorkspaceDirectoryPage } from "../../../types/ops";
import { PlatformOverviewSnapshot } from "./PlatformOverviewSnapshot.js";

/** The unresolved directory as the hook seeds it: no measured count at all. */
const unresolvedDirectory: WorkspaceDirectoryPage = { items: [], offset: 0, limit: 20, hasMore: false };

const model = (overrides: Record<string, unknown> = {}) => ({
  workspaceDirectory: { total: 0, merchantWorkspaceCount: 0 },
  platformFinanceSummary: undefined,
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
    expect(tile(html, "平台消耗金额")).toContain("12.34");
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

  it("does not present an absent finance, usage or directory read as a measured zero", () => {
    const html = render({ workspaceDirectory: unresolvedDirectory });
    expect(html).not.toContain("<small>元</small>");
    expect(tile(html, "接入费总收入")).toContain("—");
    expect(tile(html, "接入客户数")).toContain("—");
    expect(tile(html, "套餐销售额")).toContain("—");
    expect(tile(html, "客户总数")).toContain("—");
    expect(tile(html, "累计平台消耗金额")).toContain("—");
  });

  it("does not show stale dashboard values after a dataset refresh failure", () => {
    const html = render({
      workspaceDirectory: { total: 12, merchantWorkspaceCount: 9, items: [], offset: 0, limit: 20, hasMore: false },
      platformFinanceSummary: { onboardingOrderCny: 900, subscriptionOrderCny: 1200, subscriptionOrderWorkspaceCount: 4 },
      platformModelUsageSummary: usage({ providerCostStatus: "verified" }),
      dataSetError: (method: string) => method === "ops.workspaces.list" || method === "ops.finance.search" || method === "ops.model-usage.summary" ? "refresh failed" : undefined,
    });
    expect(tile(html, "客户总数")).toContain("—");
    expect(tile(html, "接入费总收入")).toContain("—");
    expect(tile(html, "套餐销售额")).toContain("—");
    expect(tile(html, "累计平台消耗金额")).toContain("—");
  });

  it("never renders an unresolved directory as a measured customer count", () => {
    // Nothing has been read from `ops.workspaces.list`, so no count exists.
    // The seed the hook actually installs is pinned in
    // `src/hooks/useOpsConsoleModel.test.ts`.
    const html = render({ workspaceDirectory: unresolvedDirectory });
    expect(tile(html, "客户总数")).toContain("—");
    expect(tile(html, "客户总数")).not.toMatch(/\d/u);
    expect(tile(html, "有效客户数")).toContain("—");
  });

  it("still renders a genuine measured zero as zero", () => {
    // The unknown state must not swallow real data: a directory that reports
    // zero customers is measured, and must read as 0 rather than "—".
    const html = render({ workspaceDirectory: { total: 0, merchantWorkspaceCount: 0, items: [], offset: 0, limit: 20, hasMore: false } });
    expect(tile(html, "客户总数")).toContain("0");
    expect(tile(html, "有效客户数")).toContain("0");
  });

  it("does not invent a gifted-customer count the server never returned", () => {
    // `total - merchantWorkspaceCount` was a derived number presented as a
    // measurement; the directory query carries no gifted semantics at all.
    const html = render({ workspaceDirectory: { total: 3, merchantWorkspaceCount: 3, items: [], offset: 0, limit: 20, hasMore: false } });
    expect(tile(html, "客户总数")).toContain("3");
    expect(tile(html, "赠送客户数")).toContain("—");
    expect(tile(html, "赠送客户数")).not.toMatch(/\d/u);
  });

  it("does not claim a month window the finance query never requested", () => {
    // `ops.finance.search` is called without a date window, so every finance
    // figure here is cumulative. The panel used to be titled 「{N}月经营数据」.
    const html = render({ platformFinanceSummary: { onboardingOrderCny: 1288 } });
    expect(html).toContain("经营数据（累计口径）");
    expect(html).toContain("平台运营概况");
    expect(html).not.toContain("平台运营实时概况");
    expect(html).not.toContain("当前月份");
    expect(html).not.toContain(`${new Date().getMonth() + 1}月经营数据`);
    expect(html).not.toContain("<small>本月</small>");
    expect(html).toContain("累计口径而非本月");
  });

  it("never fabricates a zero for the creative-point tiles that have no data source", () => {
    const html = render({ platformModelUsageSummary: usage({ providerCostStatus: "verified" }) });
    for (const label of ["累计客户消耗创意点", "客户消耗创意点", "额外创意点充值"]) {
      expect(tile(html, label), label).toContain("—");
      expect(tile(html, label), label).not.toMatch(/\d/u);
    }
  });
});
