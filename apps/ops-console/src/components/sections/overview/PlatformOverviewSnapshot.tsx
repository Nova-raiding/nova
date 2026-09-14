import { RobotOutlined } from "@ant-design/icons";
import { Button, Card, Col, Row, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../../../navigation/opsNavigation";
import { modelReadinessRows } from "./modelReadiness";

interface PlatformOverviewSnapshotProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

export function PlatformOverviewSnapshot({ model }: PlatformOverviewSnapshotProps) {
  const merchantWorkspaceCount = model.workspaceDirectory.merchantWorkspaceCount;
  const totalWorkspaceCount = model.workspaceDirectory.total;
  const giftedMerchantCount = merchantWorkspaceCount === undefined ? undefined : Math.max(0, totalWorkspaceCount - merchantWorkspaceCount);
  const finance = model.platformFinanceSummary;
  const usage = model.platformModelUsageSummary;
  const monthLabel = `${new Date().getMonth() + 1}月`;
  const basicSales = finance?.subscriptionOrderBySku?.basic?.orderCount;
  const growthSales = finance?.subscriptionOrderBySku?.growth?.orderCount;
  const trendMonths = Array.from({ length: 12 }, (_, index) => `${index + 1}月`);
  const metric = (title: string, value: string | number, unit: string, tone = "") => (
    <article className={`ops-dashboard-metric ${tone}`} key={title}>
      <span className="ops-dashboard-metric-label">{title}</span>
      <strong>{value} <small>{unit}</small></strong>
    </article>
  );

  return (
    <section className="ops-overview-snapshot" aria-label="平台运营数据">
      <section className="ops-dashboard-hero" aria-label="核心经营指标">
        <Typography.Title level={2} id="ops-overview-snapshot-title">平台运营实时概况</Typography.Title>
        <div className="ops-dashboard-current-month">当前月份：<strong>{monthLabel}</strong></div>
      </section>
      <section className="ops-dashboard-panel-grid">
        <article className="ops-dashboard-panel ops-dashboard-total"><header><div><h3>平台累计总览</h3></div><small>全部</small></header><div className="ops-dashboard-metric-list">{metric("客户总数", totalWorkspaceCount ?? 0, "家", "primary")}{metric("有效客户数", merchantWorkspaceCount ?? 0, "家", "primary")}{metric("赠送客户数", giftedMerchantCount ?? 0, "家")}{metric("接入费总收入", finance?.onboardingOrderCny ?? 0, "元", "revenue")}{metric("累计客户消耗创意点", 0, "点")}{metric("累计平台消耗金额", usage?.totalTokens ?? 0, "元")}</div></article>
        <article className="ops-dashboard-panel"><header><div><h3>{monthLabel}经营数据</h3></div><small>本月</small></header><div className="ops-dashboard-monthly-groups">
          <section><h4>接入月度</h4><div className="ops-dashboard-metric-list">{metric("接入客户数", merchantWorkspaceCount ?? 0, "家", "primary")}{metric("接入费销售额", finance?.onboardingOrderCny ?? 0, "元", "revenue")}</div></section>
          <section><h4>套餐月度</h4><div className="ops-dashboard-metric-list">{metric("套餐销量", finance?.subscriptionOrderWorkspaceCount ?? 0, "单")}{metric("套餐销售额", finance?.subscriptionOrderCny ?? 0, "元", "revenue")}{metric("2000 版本销量", basicSales ?? 0, "单")}{metric("5000 版本销量", growthSales ?? 0, "单")}</div></section>
          <section><h4>创意点月度</h4><div className="ops-dashboard-metric-list">{metric("客户消耗创意点", 0, "点")}{metric("平台消耗金额", usage?.totalTokens ?? 0, "元")}{metric("额外创意点充值", 0, "点", "full")}</div></section>
        </div></article>
      </section>
      <section className="ops-dashboard-panel ops-dashboard-trend" aria-label="年度经营趋势">
        <header><div><h3>2026年经营趋势</h3></div><small>按月</small></header>
        <div className="ops-dashboard-trend-chart" role="img" aria-label="2026年经营趋势折线图">
          <div className="ops-dashboard-trend-legend"><span className="customers">客户数</span><span className="revenue">收入</span><span className="points">创意点消耗</span><span className="cost">平台消耗金额</span></div>
          <svg viewBox="0 0 760 220" preserveAspectRatio="none" aria-hidden="true">
            {[24, 66, 108, 150].map((y) => <line key={y} x1="54" y1={y} x2="742" y2={y} className="ops-dashboard-trend-grid" />)}
            <line x1="54" y1="192" x2="742" y2="192" className="ops-dashboard-trend-axis" />
            <polyline points="54,164 116,164 178,164 240,164 302,164 364,164 426,164 488,164 550,164 612,164 674,164 736,164" className="customers-line" />
            <polyline points="54,176 116,176 178,176 240,176 302,176 364,176 426,176 488,176 550,176 612,176 674,176 736,176" className="revenue-line" />
            <polyline points="54,184 116,184 178,184 240,184 302,184 364,184 426,184 488,184 550,184 612,184 674,184 736,184" className="points-line" />
            <polyline points="54,152 116,152 178,152 240,152 302,152 364,152 426,152 488,152 550,152 612,152 674,152 736,152" className="cost-line" />
          </svg>
          <div className="ops-dashboard-trend-labels">{trendMonths.map((month) => <span key={month}>{month}</span>)}</div>
        </div>
      </section>

    </section>
  );
}

/** Detailed model readiness belongs below the first-screen platform pulse. */
export function ModelLaunchRisk({ model, onNavigate }: PlatformOverviewSnapshotProps) {
  const modelStatusError = model.dataSetError("platform.model.status");
  const displayModelStatus = modelStatusError ? undefined : model.modelStatus;
  const readiness = modelReadinessRows(displayModelStatus);
  const blockedReadiness = readiness.filter((row) => !row.ready);

  return (
    <Row gutter={[12, 12]} className="ops-overview-status-grid">
      <Col xs={24}>
        <Card
          size="small"
          title={<span><RobotOutlined /> 模型上线风险</span>}
          extra={<Button type="link" onClick={() => onNavigate?.("finance")}>前往账务中心</Button>}
        >
          <div className="ops-overview-readiness-list" aria-live="polite">
            {modelStatusError ? (
              <Typography.Text type="secondary">模型状态读取失败，当前不能判定能力是否可用；请进入模型详情重试。</Typography.Text>
            ) : blockedReadiness.length ? (
              <>
                <Typography.Text type="secondary">{blockedReadiness.length} 项能力未通过最终运行时门禁，首页仅展示阻断摘要。</Typography.Text>
                {blockedReadiness.slice(0, 2).map((row) => (
                  <div className="ops-overview-readiness-row" key={row.key}>
                    <span className="ops-overview-status-dot blocked" />
                    <strong>{row.label}</strong>
                    <Tag color="red">阻断</Tag>
                    <Typography.Text type="secondary">{row.reasons[0] ?? "等待服务端确认"}</Typography.Text>
                  </div>
                ))}
                {blockedReadiness.length > 2 ? <Typography.Text type="secondary">另有 {blockedReadiness.length - 2} 项阻断，详见平台总览。</Typography.Text> : null}
              </>
            ) : displayModelStatus ? (
              <Typography.Text type="secondary">五模态均已通过最终运行时门禁；具体成本和计费倍率请在账务中心核对。</Typography.Text>
            ) : (
              <Typography.Text type="secondary">模型状态尚未取得，不能把配置状态解释为可用。</Typography.Text>
            )}
          </div>
        </Card>
      </Col>
    </Row>
  );
}
