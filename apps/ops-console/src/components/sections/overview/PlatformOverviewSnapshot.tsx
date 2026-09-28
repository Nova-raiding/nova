import { Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../../../navigation/opsNavigation";

interface PlatformOverviewSnapshotProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

export function PlatformOverviewSnapshot({ model }: PlatformOverviewSnapshotProps) {
  const directoryReadFailed = Boolean(model.dataSetError("ops.workspaces.list"));
  const financeReadFailed = Boolean(model.dataSetError("ops.finance.search"));
  const usageReadFailed = Boolean(model.dataSetError("ops.model-usage.summary"));
  // The directory is requested with merchant_only=true. Its total is therefore
  // the number of workspaces linked to active merchant accounts, not every
  // platform workspace. The separate merchantWorkspaceCount headline is
  // counted globally and duplicates this number for the unfiltered overview.
  const linkedMerchantWorkspaceCount = directoryReadFailed ? undefined : model.workspaceDirectory.total;
  // The server returns no gifted-customer semantics (the directory query is
  // merchant-only and exposes no grant marker), so the previous
  // `total - merchantWorkspaceCount` subtraction was an invented metric. It is
  // reported as not-integrated until a real data source exists.
  const giftedMerchantCount = undefined;
  const finance = financeReadFailed ? undefined : model.platformFinanceSummary;
  const usage = usageReadFailed ? undefined : model.platformModelUsageSummary;
  // Provider cost is only meaningful when the server marked the cost evidence
  // verified. `totalTokens` is a token count, not currency: rendering it against
  // 「元」 overstated platform spend by roughly six orders of magnitude on the
  // operator's most-screenshotted panel, so it is never used as money here.
  const platformProviderCost = usage && usage.providerCostStatus === "verified" && usage.providerCostCny !== null
    ? usage.providerCostCny.toFixed(2)
    : undefined;
  // Finance search has no date window; preserve the reference layout while
  // exposing which figures the API actually returns as cumulative snapshots.
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
        <div>
          <Typography.Title level={2} id="ops-overview-snapshot-title">平台运营实时概况</Typography.Title>
        </div>
        <div className="ops-dashboard-current-month">当前月份：<strong>{new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric" })}</strong></div>
      </section>
      <section className="ops-dashboard-panel-grid">
        <article className="ops-dashboard-panel ops-dashboard-total"><header><div><h3>平台累计总览</h3></div><small>全部</small></header><div className="ops-dashboard-metric-list">{metric("客户总数", directoryReadFailed ? undefined : model.workspaceDirectory.total, "家", "primary")}{metric("有效客户数", linkedMerchantWorkspaceCount, "家", "primary")}{metric("赠送客户数", giftedMerchantCount, "家")}{metric("接入费总收入", finance?.onboardingOrderCny, "元", "revenue")}{metric("累计客户消耗创意点", undefined, "点")}{metric("累计平台消耗金额", platformProviderCost, "元", "revenue")}</div></article>
        <article className="ops-dashboard-panel"><header><div><h3>{new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric" })}经营数据</h3></div><small>本月</small></header><div className="ops-dashboard-monthly-groups">
          <section><h4>接入月度</h4><div className="ops-dashboard-metric-list">{metric("接入客户数", undefined, "家", "primary")}{metric("接入费销售额", finance?.onboardingOrderCny, "元", "revenue")}</div></section>
          <section><h4>套餐月度</h4><div className="ops-dashboard-metric-list">{metric("套餐销量", undefined, "单")}{metric("套餐销售额", finance?.subscriptionOrderCny, "元", "revenue")}{metric("2000 版本销量", undefined, "单")}{metric("5000 版本销量", undefined, "单")}</div></section>
          <section><h4>创意点月度</h4><div className="ops-dashboard-metric-list">{metric("客户消耗创意点", undefined, "点")}{metric("平台消耗金额", platformProviderCost, "元", "revenue")}{metric("额外创意点充值", undefined, "点", "full")}</div></section>
        </div>
          <p className="ops-dashboard-panel-note">当前财务与模型接口返回累计数据；月度订单、销量和创意点统计暂无可验证的数据源。</p>
        </article>
      </section>
    </section>
  );
}
