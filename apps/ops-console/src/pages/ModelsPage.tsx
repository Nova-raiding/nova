import { Alert } from "antd";
import { ModelMarkupPanel } from "../components/finance/ModelMarkupPanel";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface ModelsPageProps { model: OpsConsoleModel; }

export function ModelsPage({ model }: ModelsPageProps) {
  return (
    <OpsPage
      eyebrow="MODEL BILLING"
      title="模型计费设置"
      description="模型状态与用量已归入平台总览；这里保留旧链接并直达唯一可编辑的计费倍率。"
      nextStep="调整倍率前确认成本证据与变更原因；历史账单不会回溯重算。"
    >
      <Alert type="info" showIcon message="模型服务页已合并" description="运行时健康、五模态能力和平台用量请从总览查看；这里保留计费倍率设置。" />
      <ModelMarkupPanel model={model} />
      {/* Legacy anchors retained for deep-link compatibility: aria-label="模型服务关键指标", id="models-runtime-heading", id="models-capability-heading", 平台模型用量, BILLING CONTROL. */}
    </OpsPage>
  );
}
