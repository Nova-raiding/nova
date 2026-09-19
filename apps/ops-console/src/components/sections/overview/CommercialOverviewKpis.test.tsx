import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import { CommercialOverviewKpis } from "./CommercialOverviewSection.js";

const render = (finance: Record<string, unknown> | undefined) =>
  renderToStaticMarkup(
    <CommercialOverviewKpis model={{ platformFinanceSummary: finance } as unknown as OpsConsoleModel} />,
  );

describe("CommercialOverviewKpis labels", () => {
  it("does not label the recharge total as the onboarding fee", () => {
    // `verifiedRechargeOrderCny` is paid recharge income (the finance ledger
    // calls it 「真实充值到账」); the onboarding fee is a different field that
    // the platform snapshot panel renders under its own title.
    const html = render({ verifiedRechargeOrderCny: 640, onboardingOrderCny: 1288 });
    expect(html).toContain("真实充值到账");
    expect(html).not.toContain("总接入费收入");
    expect(html).toContain("640");
  });

  it("does not claim a month window the finance query never requested", () => {
    const html = render({ subscriptionOrderWorkspaceCount: 3, subscriptionOrderCny: 900 });
    expect(html).toContain("套餐销售量（累计）");
    expect(html).toContain("套餐销售额（累计）");
    expect(html).not.toContain("月度套餐销售量");
    expect(html).not.toContain("月度套餐销售额");
  });

  it("keeps the unknown state when no finance read resolved", () => {
    const html = render(undefined);
    expect(html).toContain("—");
    expect(html).not.toContain("真实充值到账0");
  });
});
