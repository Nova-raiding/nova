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
          extra={<Button type="link" onClick={() => onNavigate("models")}>查看模型设置</Button>}
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
              <Typography.Text type="secondary">五模态均已通过最终运行时门禁；具体成本和计费倍率请在模型设置中核对。</Typography.Text>
            ) : (
              <Typography.Text type="secondary">模型状态尚未取得，不能把配置状态解释为可用。</Typography.Text>
            )}
          </div>
        </Card>
      </Col>
    </Row>
  );
}
