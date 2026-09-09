import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { CommercialOverviewSection } from "../components/sections/overview/CommercialOverviewSection";
import { DataReadinessSection } from "../components/sections/overview/DataReadinessSection";
import { ModelServiceSummary } from "../components/models/ModelServiceSummary";
import { StorageReconciliationSummary } from "../components/storage/StorageReconciliationSummary";
import { PlatformReadinessSection } from "../components/sections/overview/PlatformReadinessSection";
import { Alert, Button, Card, Col, Row, Statistic, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../navigation/opsNavigation";

interface OverviewPageProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

export function WorkspaceDataCoverage({ metrics }: { metrics: OpsConsoleModel["workspaceMetrics"] }) {
  if (!metrics?.dataCoverage) return null;
  const coverage = metrics.dataCoverage;
  const invalidSnapshots = metrics.hydration?.invalidSnapshotCount ?? 0;
  const partial = metrics.dataCompleteness === "partial" || invalidSnapshots > 0;
  return (
    <Card title="数据覆盖与完整性" style={{ marginTop: 16 }} extra={<Tag color={partial ? "orange" : "green"}>{partial ? "部分数据" : "完整"}</Tag>}>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}><Statistic title="商品事实" value={coverage.products ?? "—"} /></Col>
        <Col xs={12} md={6}><Statistic title="内容任务" value={coverage.tasks ?? "—"} /></Col>
        <Col xs={12} md={6}><Statistic title="同步作业" value={coverage.syncJobs ?? "—"} /></Col>
        <Col xs={12} md={6}><Statistic title="发布作业" value={coverage.publishJobs ?? "—"} /></Col>
      </Row>
      {partial ? <Alert style={{ marginTop: 16 }} type="warning" showIcon title="总览不是完整快照" description={`当前数据源：${metrics.source ?? "未知"}；无效持久化快照：${invalidSnapshots}。请先修复数据恢复/快照问题，再依据总览做运营决策。${coverage.fixtureDataPresent ? "当前包含 fixture 数据，不代表真实平台生产数据。" : ""}`} /> : null}
      {!partial && coverage.fixtureDataPresent ? <Typography.Text type="secondary">当前包含 fixture 数据，仅用于本地验收，不代表真实平台生产数据。</Typography.Text> : null}
    </Card>
  );
}

export function OverviewPage({ model, onNavigate }: OverviewPageProps) {
  const overviewError = model.dataSetError(
    "workspace.commercial.get",
    "workspace.health",
    "workspace.metrics",
    "platform.model.status",
    "ops.alerts.list",
    "ops.data.delete.list",
    "ops.growth.funnel",
  );
  return (
    <OpsPage
      eyebrow="OVERVIEW"
      title="运营总览"
      description="查看套餐、模型、平台告警和上线状态。"
      actions={<Button type="primary" loading={model.loading} onClick={() => void model.load()}>刷新总览</Button>}
    >
      <div className="ops-overview-page">
      <OpsPageError error={overviewError ?? ""} onRetry={() => void model.load()} />
      <CommercialOverviewSection model={model} />
      <WorkspaceDataCoverage metrics={model.workspaceMetrics} />
      <ModelServiceSummary
        status={model.modelStatus}
        loading={model.modelStatusLoading}
        onOpen={() => onNavigate("models")}
      />
      <StorageReconciliationSummary
        summary={model.workspaceMetrics?.storageReconciliation}
        onOpen={() => onNavigate("storage")}
      />
      <PlatformReadinessSection model={model} />
      <DataReadinessSection model={model} />
      </div>
    </OpsPage>
  );
}
