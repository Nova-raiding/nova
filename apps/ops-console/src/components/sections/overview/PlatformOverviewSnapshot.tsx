import { Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../../../navigation/opsNavigation";

interface PlatformOverviewSnapshotProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

export function PlatformOverviewSnapshot({ model }: PlatformOverviewSnapshotProps) {
  const merchantWorkspaceCount = model.workspaceDirectory.merchantWorkspaceCount;
  // `undefined` until `ops.workspaces.list` resolves: an unread directory is
  // unknown, so the tile reads "—" instead of a measured "0 家".
  const totalWorkspaceCount = model.workspaceDirectory.total;
  // The server returns no gifted-customer semantics (the directory query is
  // merchant-only and exposes no grant marker), so the previous
  // `total - merchantWorkspaceCount` subtraction was an invented metric. It is
  // reported as not-integrated until a real data source exists.
  const giftedMerchantCount = undefined;
  const finance = model.platformFinanceSummary;
  const usage = model.platformModelUsageSummary;
  const basicSales = finance?.subscriptionOrderBySku?.basic?.orderCount;
  const growthSales = finance?.subscriptionOrderBySku?.growth?.orderCount;
  // Provider cost is only meaningful when the server marked the cost evidence
  // verified. `totalTokens` is a token count, not currency: rendering it against
  // 「元」 overstated platform spend by roughly six orders of magnitude on the
  // operator's most-screenshotted panel, so it is never used as money here.
  const platformProviderCost = usage && usage.providerCostStatus === "verified" && usage.providerCostCny !== null
    ? usage.providerCostCny.toFixed(2)
    : undefined;
  // `ops.finance.search` is called without `from_at`/`to_at`, so every finance
  // figure on this page is a whole-ledger snapshot. Claiming a "本月" window
  // would state a range the query never asked for; the panel states the
  // cumulative scope it actually has and discloses the missing window instead.
  const monthLabel = `${new Date().getMonth() + 1}月`;
  // Passing `undefined` renders an explicit unknown. A literal 0 is
  // indistinguishable from a measured zero, so a failed or absent API read must
  // not be displayed as one.
  const metric = (title: string, value: string | number | undefined, unit: string, tone = "") => (
    <article className={`ops-dashboard-metric ${tone}`} key={title}>
      <span className="ops-dashboard-metric-label">{title}</span>
      <strong>{value === undefined ? "—" : value} {value === undefined ? null : <small>{unit}</small>}</strong>
    </article>
  );

  return (
    <section className="ops-overview-snapshot" aria-label="平台运营数据">
      <section className="ops-dashboard-hero" aria-label="核心经营指标">
        <Typography.Title level={2} id="ops-overview-snapshot-title">平台运营实时概况</Typography.Title>
        <div className="ops-dashboard-current-month">当前月份：<strong>{monthLabel}</strong></div>
      </section>
      <section className="ops-dashboard-panel-grid">
        <article className="ops-dashboard-panel ops-dashboard-total"><header><div><h3>平台累计总览</h3></div><small>全部</small></header><div className="ops-dashboard-metric-list">{metric("客户总数", totalWorkspaceCount, "家", "primary")}{metric("有效客户数", merchantWorkspaceCount, "家", "primary")}{metric("赠送客户数", giftedMerchantCount, "家")}{metric("接入费总收入", finance?.onboardingOrderCny, "元", "revenue")}{metric("累计客户消耗创意点", undefined, "点")}{metric("累计平台消耗金额", platformProviderCost, "元", "revenue")}</div></article>
        <article className="ops-dashboard-panel"><header><div><h3>经营数据（累计口径）</h3></div><small>累计</small></header><div className="ops-dashboard-monthly-groups">
          <section><h4>接入</h4><div className="ops-dashboard-metric-list">{metric("接入客户数", merchantWorkspaceCount, "家", "primary")}{metric("接入费销售额", finance?.onboardingOrderCny, "元", "revenue")}</div></section>
          <section><h4>套餐</h4><div className="ops-dashboard-metric-list">{metric("套餐销量", finance?.subscriptionOrderWorkspaceCount, "单")}{metric("套餐销售额", finance?.subscriptionOrderCny, "元", "revenue")}{metric("2000 版本销量", basicSales, "单")}{metric("5000 版本销量", growthSales, "单")}</div></section>
          <section><h4>创意点</h4><div className="ops-dashboard-metric-list">{metric("客户消耗创意点", undefined, "点")}{metric("平台消耗金额", platformProviderCost, "元", "revenue")}{metric("额外创意点充值", undefined, "点", "full")}</div></section>
        </div>
          <p className="ops-dashboard-panel-note">平台经营数据接口未提供日期窗口（财务检索未传起止时间），以上数值与「平台累计总览」同源，是累计口径而非本月；请勿按月度解读。</p>
        </article>
      </section>
    </section>
  );
}
