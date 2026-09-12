import {
  CheckCircleOutlined,
  DollarOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Col, Row, Space, Statistic, Tag, Typography } from "antd";
import { ModelMarkupPanel } from "../components/finance/ModelMarkupPanel";
import { ModelStatusSection } from "../components/models/ModelStatusSection";
import { ModelChannelMatrix } from "../components/models/ModelChannelMatrix";
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { modelCostReadiness, modelReadinessRows } from "../components/sections/overview/modelReadiness";
import { visibleModelsPageSections } from "./modelsPageVisibility";

interface ModelsPageProps {
  model: OpsConsoleModel;
}

export function ModelsPage({ model }: ModelsPageProps) {
  const visibleSections = visibleModelsPageSections(model.canModelMarkup);
  const modelError = model.dataSetError("platform.model.status");
  const status = model.modelStatus;
  const readinessRows = modelReadinessRows(status);
  const readyCount = readinessRows.filter((row) => row.ready).length;
  const costReadiness = modelCostReadiness(status);

  return (
    <OpsPage
      eyebrow="MODEL SERVICES"
      title="模型服务"
      description="集中查看文本、图片、编辑、OCR 与视频能力的最终 readiness、成本证据和上线阻断。"
      actions={<Button type="primary" loading={model.loading || model.modelStatusLoading} onClick={() => void model.load()}>刷新模型状态</Button>}
      nextStep={modelError ? "先恢复模型状态读取；在 readiness 未确认前保持所有生成能力阻断。" : "先处理阻断项，再核对成本证据与五模态 readiness。"}
    >
      <div className="ops-models-page">
      <OpsPageError error={modelError ?? ""} onRetry={() => void model.load()} />

      <section className="ops-models-overview" aria-label="模型服务关键指标">
        <Card className="ops-models-metric-card ops-models-metric-primary" size="small">
          <Statistic title="最终可用能力" value={status ? readyCount : "—"} suffix={status ? `/ ${readinessRows.length}` : undefined} prefix={<CheckCircleOutlined />} />
          <Typography.Text type="secondary">通过运行时与商业门禁</Typography.Text>
        </Card>
        <Card className="ops-models-metric-card" size="small">
          <Statistic title="阻断能力" value={status ? readinessRows.length - readyCount : "—"} prefix={<SafetyCertificateOutlined />} />
          <Typography.Text type="secondary">需要处理的模态</Typography.Text>
        </Card>
        <Card className="ops-models-metric-card" size="small">
          <Statistic title="成本证据" value={status ? (costReadiness.ready ? "已验证" : "待处理") : "—"} prefix={<DollarOutlined />} />
          <Typography.Text type="secondary">{costReadiness.ready ? "计费组与成本记录完整" : "不能解释为 ¥0"}</Typography.Text>
        </Card>
        <Card className="ops-models-metric-card" size="small">
          <Statistic title="发布证据" value={status ? (status.release_metadata_ready ? "已就绪" : "未就绪") : "—"} prefix={<RocketOutlined />} />
          <Typography.Text type="secondary">release metadata 状态</Typography.Text>
        </Card>
      </section>

      <section className="ops-models-section" aria-labelledby="models-runtime-heading">
        <div className="ops-models-section-heading">
          <div>
            <Typography.Text className="ops-models-section-kicker">RUNTIME HEALTH</Typography.Text>
            <Typography.Title id="models-runtime-heading" level={3}>运行时健康</Typography.Title>
          </div>
          <Typography.Text type="secondary">先看平台状态，再处理具体模态</Typography.Text>
        </div>
        <ModelStatusSection model={model} />
      </section>

      <section className="ops-models-section" aria-labelledby="models-capability-heading">
        <div className="ops-models-section-heading">
          <div>
            <Typography.Text className="ops-models-section-kicker">CAPABILITY MATRIX</Typography.Text>
            <Typography.Title id="models-capability-heading" level={3}>五模态能力矩阵</Typography.Title>
          </div>
          <Typography.Text type="secondary">配置、成本证据和最终状态分别核验</Typography.Text>
        </div>
        <ModelChannelMatrix status={model.modelStatus} fixtureDataPresent={model.dataSource?.fixtureDataPresent} />
      </section>

      {model.authorization.can("billing.platform.read") && model.platformModelUsageSummary ? (
        <Card className="ops-models-usage-card" title={<Space><ThunderboltOutlined aria-hidden="true" />平台模型用量</Space>} extra={<Tag color="blue">平台范围</Tag>} size="small">
          <Row gutter={[16, 16]}>
            <Col span={6}><Statistic title="调用记录" value={model.platformModelUsageSummary.recordCount} /></Col>
            <Col span={6}><Statistic title="总 Token" value={model.platformModelUsageSummary.totalTokens} /></Col>
            <Col span={6}><Statistic title="Provider 成本" value={model.platformModelUsageSummary.providerCostCny ?? "—"} precision={6} prefix={model.platformModelUsageSummary.providerCostCny == null ? undefined : "¥"} /></Col>
            <Col span={6}><Statistic title="未结算" value={model.platformModelUsageSummary.unsettledRecordCount} /></Col>
          </Row>
          {model.platformModelUsageSummary.failedWorkspaceCount ? <Alert style={{ marginTop: 16 }} type="warning" showIcon title={`${model.platformModelUsageSummary.failedWorkspaceCount} 个企业主体用量读取失败，未纳入汇总`} /> : null}
          {model.platformModelUsageSummary.providerCostStatus && model.platformModelUsageSummary.providerCostStatus !== "verified" ? <Alert style={{ marginTop: 16 }} type="warning" showIcon title="Provider 成本证据不完整" description={model.platformModelUsageSummary.providerCostStatus === "unavailable" ? "成本汇总不可用，不能解释为 ¥0。" : `有 ${model.platformModelUsageSummary.missingCostEvidenceCount ?? 0} 条用量记录缺少成本证据。`} /> : null}
        </Card>
      ) : null}
      {visibleSections.includes("model-markup") ? (
        <section className="ops-models-section" aria-labelledby="models-billing-heading">
          <div className="ops-models-section-heading">
            <div>
              <Typography.Text className="ops-models-section-kicker">BILLING CONTROL</Typography.Text>
              <Typography.Title id="models-billing-heading" level={3}>计费控制</Typography.Title>
            </div>
            <Typography.Text type="secondary">变更需要原因并保留 revision</Typography.Text>
          </div>
          <ModelMarkupPanel model={model} />
        </section>
      ) : null}
      </div>
    </OpsPage>
  );
}
