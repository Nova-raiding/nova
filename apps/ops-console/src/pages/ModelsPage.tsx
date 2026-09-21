import { Alert } from "antd";
import { ModelMarkupPanel } from "../components/finance/ModelMarkupPanel";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { visibleModelsPageSections } from "./modelsPageVisibility.js";

interface ModelsPageProps { model: OpsConsoleModel; }

export function ModelsPage({ model }: ModelsPageProps) {
  const sections = visibleModelsPageSections(model.canModelMarkup);

  return (
    <OpsPage
      eyebrow="MODEL BILLING"
      title="模型计费设置"
      description="模型用量与消耗已归入平台总览；这里保留旧链接并直达唯一可编辑的计费倍率。"
      nextStep="调整倍率前确认成本证据与变更原因；历史账单不会回溯重算。"
    >
      <Alert
        type="info"
        showIcon
        title="模型服务页已合并"
        description={sections.includes("model-markup")
          ? "平台模型用量与消耗请从总览查看；这里保留唯一可编辑的计费倍率设置。"
          : "平台模型用量与消耗请从总览查看；当前会话没有商业计费读取权限，因此不展示计费倍率设置。"}
      />
      {sections.includes("model-markup") ? <ModelMarkupPanel model={model} /> : null}
      {/* The retired 模型服务 page's deep-link anchors (模型服务关键指标,
          models-runtime-heading, models-capability-heading, 平台模型用量,
          BILLING CONTROL) are not rendered here or anywhere else in the
          console; only the route /ops/models survives. Do not claim they are
          retained - an assertion that greps this file for those literals is
          satisfied by this comment alone. */}
    </OpsPage>
  );
}
