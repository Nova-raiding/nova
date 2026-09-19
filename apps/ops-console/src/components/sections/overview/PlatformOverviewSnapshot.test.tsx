import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { PlatformModelUsageSummary } from "../../../types/ops";
import { PlatformOverviewSnapshot } from "./PlatformOverviewSnapshot.js";

const model = (overrides: Record<string, unknown> = {}) => ({
  workspaceDirectory: { total: 0, merchantWorkspaceCount: 0 },
  platformFinanceSummary: undefined,
  platformModelUsageSummary: undefined,
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

/** The rendered value + unit of one dashboard tile, sliced from its label. */
const tile = (html: string, label: string) => {
  const start = html.indexOf(label);
  expect(start, `tile ${label} is missing`).toBeGreaterThan(-1);
  return html.slice(start + label.length, html.indexOf("</strong>", start));
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

  it("shows an explicit unknown when provider cost evidence is not verified", () => {
    // `providerCostStatus: "partial"` means the server could not evidence the
    // cost. Showing the number anyway would state an unverified cost as fact.
    const html = render({ platformModelUsageSummary: usage({ providerCostStatus: "partial" }) });
    expect(tile(html, "累计平台消耗金额")).not.toContain("12.34");
    expect(tile(html, "累计平台消耗金额")).toContain("—");
    expect(html).not.toContain("48213905");
  });

  it("does not present an absent finance, usage or directory read as a measured zero", () => {
    const html = render({ workspaceDirectory: {} });
    expect(html).not.toContain("<small>元</small>");
    expect(tile(html, "接入费总收入")).toContain("—");
    expect(tile(html, "接入客户数")).toContain("—");
    expect(tile(html, "套餐销售额")).toContain("—");
    expect(tile(html, "客户总数")).toContain("—");
    expect(tile(html, "累计平台消耗金额")).toContain("—");
  });

  it("still renders a genuine measured zero as zero", () => {
    // The unknown state must not swallow real data: a directory that reports
    // zero customers is measured, and must read as 0 rather than "—".
    const html = render({ workspaceDirectory: { total: 3, merchantWorkspaceCount: 3 } });
    expect(tile(html, "客户总数")).toContain("3");
    expect(tile(html, "赠送客户数")).toContain("0");
  });

  it("never fabricates a zero for the creative-point tiles that have no data source", () => {
    const html = render({ platformModelUsageSummary: usage({ providerCostStatus: "verified" }) });
    for (const label of ["累计客户消耗创意点", "客户消耗创意点", "额外创意点充值"]) {
      expect(tile(html, label), label).toContain("—");
      expect(tile(html, label), label).not.toMatch(/\d/u);
    }
  });
});
