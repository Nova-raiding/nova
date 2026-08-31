import { Alert, Card, Col, Row, Statistic } from "antd";
import { ModelMarkupPanel } from "../components/finance/ModelMarkupPanel";
import { ModelStatusSection } from "../components/models/ModelStatusSection";
import { ModelChannelMatrix } from "../components/models/ModelChannelMatrix";
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { visibleModelsPageSections } from "./modelsPageVisibility";

interface ModelsPageProps {
  model: OpsConsoleModel;
}

export function ModelsPage({ model }: ModelsPageProps) {
  const visibleSections = visibleModelsPageSections(model.canModelMarkup);
  const modelError = model.dataSetError("platform.model.status");
  return (
    <OpsPage
      eyebrow="MODEL SERVICES"
      title="模型服务"
      description="集中查看文本、图片、编辑、OCR 与视频能力的最终 readiness、成本证据和上线阻断。"
      nextStep={modelError ? "先恢复模型状态读取；在 readiness 未确认前保持所有生成能力阻断。" : "先处理阻断项，再核对成本证据与五模态 readiness。"}
    >
      <OpsPageError error={modelError ?? ""} onRetry={() => void model.load()} />
      <ModelStatusSection model={model} />
      <ModelChannelMatrix status={model.modelStatus} />
      {model.authorization.can("billing.platform.read") && model.platformModelUsageSummary ? (
        <Card title="平台模型用量汇总" size="small">
          <Row gutter={[16, 16]}>
            <Col span={6}><Statistic title="调用记录" value={model.platformModelUsageSummary.recordCount} /></Col>
            <Col span={6}><Statistic title="总 Token" value={model.platformModelUsageSummary.totalTokens} /></Col>
            <Col span={6}><Statistic title="Provider 成本" value={model.platformModelUsageSummary.providerCostCny} precision={6} prefix="¥" /></Col>
            <Col span={6}><Statistic title="未结算" value={model.platformModelUsageSummary.unsettledRecordCount} /></Col>
          </Row>
          {model.platformModelUsageSummary.failedWorkspaceCount ? <Alert style={{ marginTop: 16 }} type="warning" showIcon title={`${model.platformModelUsageSummary.failedWorkspaceCount} 个工作区用量读取失败，未纳入汇总`} /> : null}
        </Card>
      ) : null}
      {visibleSections.includes("model-markup") ? (
        <ModelMarkupPanel model={model} />
      ) : null}
    </OpsPage>
  );
}
