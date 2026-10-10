import { Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../../../navigation/opsNavigation";
import { dashboardMonthLabel, formatOverviewCurrency } from "./financeWindow.js";

interface PlatformOverviewSnapshotProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

export function PlatformOverviewSnapshot({ model }: PlatformOverviewSnapshotProps) {
  const directoryReadFailed = Boolean(model.dataSetError("ops.workspaces.list"));
  const financeReadFailed = Boolean(model.dataSetError("ops.finance.search"));
  const usageReadFailed = Boolean(model.dataSetError("ops.model-usage.summary"));
  // The directory is requested with merchant_only=true, so this total means
  // workspaces linked to active merchant accounts, not every platform workspace.
  const linkedMerchantWorkspaceCount = directoryReadFailed ? undefined : model.workspaceDirectory.total;
  const activeMemberWorkspaceCount = directoryReadFailed ? undefined : model.workspaceDirectory.activeMemberWorkspaceCount;
  // The server returns no gifted-customer semantics (the directory query is
  // merchant-only and exposes no grant marker), so the previous
  // `total - merchantWorkspaceCount` subtraction was an invented metric. It is
  // reported as not-integrated until a real data source exists.
  const giftedMerchantCount = undefined;
  const finance = financeReadFailed ? undefined : model.platformFinanceSummary;
  const monthlyFinance = financeReadFailed ? undefined : model.platformMonthlyFinanceSummary;
  const dashboardMonth = dashboardMonthLabel(model.platformMonthlyFinanceMonth);
  const usage = usageReadFailed ? undefined : model.platformModelUsageSummary;
  // Provider cost is only meaningful when the server marked the cost evidence
  // verified. `totalTokens` is a token count, not currency: rendering it against
  // 「元」 overstated platform spend by roughly six orders of magnitude on the
  // operator's most-screenshotted panel, so it is never used as money here.
  const platformProviderCost = usage && usage.providerCostStatus === "verified" && usage.providerCostCny !== null
    ? formatOverviewCurrency(usage.providerCostCny)
    : undefined;
  // The monthly query carries the full all-kind commercial SKU summary. Use
  // the catalog's monthly type to avoid counting onboarding/point-pack SKUs.
  const monthlyBundleCounts = monthlyFinance?.commercialOrderBySku;
  const monthlySkuCodes = new Set(model.platformCommercialCatalog
    .filter((item) => item.type === "monthly")
    .map((item) => item.skuCode));
  const monthlyBundleCount = monthlyBundleCounts
    ? Object.entries(monthlyBundleCounts)
      .filter(([skuCode]) => monthlySkuCodes.has(skuCode))
      .reduce((total, [, sku]) => total + sku.orderCount, 0)
    : undefined;
  const skuOrdersFor = (aliases: readonly string[]) => {
    if (!monthlyBundleCounts) return undefined;
    const catalogCodes = model.platformCommercialCatalog
      .filter((item) => item.type === "monthly" && aliases.includes(item.skuCode))
      .map((item) => item.skuCode);
    const codes = catalogCodes.length ? catalogCodes : aliases;
    const matches = codes.flatMap((skuCode) => {
      const summary = monthlyBundleCounts[skuCode];
      return summary ? [summary.orderCount] : [];
    });
    if (!matches.length && catalogCodes.length) return 0;
    return matches.length ? matches.reduce((total, count) => total + count, 0) : undefined;
  };
  const metric = (title: string, value: string | number | undefined, unit: string, tone = "") => (
    <article className={`ops-dashboard-metric ${tone}`} key={title} aria-label={`${title}：${value === undefined ? "未知" : value} ${unit}`}>
      <span className="ops-dashboard-metric-label">{title}</span>
      <strong>{value === undefined ? "—" : value} <small>{unit}</small></strong>
    </article>
  );
  return (
    <section className="ops-overview-snapshot" aria-label="平台运营数据">
      <section className="ops-dashboard-hero" aria-label="核心经营指标">
        <div>
          <Typography.Title level={2} id="ops-overview-snapshot-title">平台运营实时概况</Typography.Title>
        </div>
        <div className="ops-dashboard-current-month">当前月份：<strong>{dashboardMonth}</strong></div>
      </section>
      <section className="ops-dashboard-panel-grid">
        <article className="ops-dashboard-panel ops-dashboard-total"><header><div><h3>平台累计总览</h3></div><small>全部</small></header><div className="ops-dashboard-metric-list">{metric("已关联商家工作区", linkedMerchantWorkspaceCount, "个", "primary")}{metric("有活跃成员的工作区", activeMemberWorkspaceCount, "个", "primary")}{metric("赠送客户数", giftedMerchantCount, "家")}{metric("接入费总收入", finance?.onboardingOrderCny, "元", "revenue")}{metric("累计客户消耗创意点", undefined, "点")}{metric("累计平台消耗金额", platformProviderCost, "元", "revenue")}</div></article>
        <article className="ops-dashboard-panel"><header><div><h3>{dashboardMonth === "—" ? "本月" : dashboardMonth}经营数据</h3></div><small>本月</small></header><div className="ops-dashboard-monthly-groups">
          <section><h4>接入月度</h4><div className="ops-dashboard-metric-list">{metric("接入客户数", monthlyFinance?.onboardingOrderWorkspaceCount, "家", "primary")}{metric("接入费销售额", monthlyFinance?.onboardingOrderCny, "元", "revenue")}</div></section>
          <section><h4>套餐月度</h4><div className="ops-dashboard-metric-list">{metric("套餐销量", monthlyBundleCount, "单")}{metric("套餐销售额", monthlyFinance?.subscriptionOrderCny, "元", "revenue")}{metric("2000 版本销量", skuOrdersFor(["sku-monthly-basic", "monthly-basic", "monthly_basic", "basic", "sku-monthly-2000"]), "单")}{metric("5000 版本销量", skuOrdersFor(["sku-monthly-growth", "monthly-growth", "monthly_growth", "growth", "sku-monthly-5000"]), "单")}</div></section>
          <section><h4>创意点月度</h4><div className="ops-dashboard-metric-list">{metric("客户消耗创意点", undefined, "点")}{metric("平台消耗金额", undefined, "元", "revenue")}{metric("额外创意点充值", undefined, "点", "full")}</div></section>
        </div>
          <p className="ops-dashboard-data-note sr-only">月度金额统计本自然月内创建且已付款的订单；跨月付款仍按订单创建月份归类。创意点和月度模型成本接口暂无可验证数据源。</p>
        </article>
      </section>
    </section>
  );
}
