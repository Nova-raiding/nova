import { Alert, Button } from "antd";
import { ModelMarkupPanel } from "../components/finance/ModelMarkupPanel";
import { OpsPage } from "../components/OpsPage";
import type { OpsDomainPageProps } from "../navigation/opsPageRegistry.js";
import { modelStateLabel } from "../components/sections/overview/modelReadiness.js";
import { visibleModelsPageSections } from "./modelsPageVisibility.js";

export function ModelsPage({ model, onNavigate }: OpsDomainPageProps) {
  const sections = visibleModelsPageSections(model.canModelMarkup);
  const modelStatusError = model.dataSetError("platform.model.status");
  const canVerifyRelay = model.authorization.can("model.status.read");
  const relayReady = canVerifyRelay && !model.modelStatusLoading && !modelStatusError
    && model.dataSource?.fixtureDataPresent !== true
    && model.modelStatus?.state === "ready"
    && model.modelStatus.relay?.configured === true;
  const relayGateMessage = !canVerifyRelay
    ? "当前会话没有模型状态读取权限，无法核实中转与五模态运行状态。请联系平台管理员确认权限。"
    : model.modelStatusLoading
      ? "正在核实平台模型与中转状态；验证完成前不会请求计费倍率配置。"
      : modelStatusError
        ? "平台模型状态读取失败：" + modelStatusError + "。请先在平台总览重试模型状态读取。"
        : model.dataSource?.fixtureDataPresent === true
          ? "当前模型状态含演示数据，不能作为中转就绪证据。请切换到真实服务数据源后再读取计费倍率。"
          : !model.modelStatus
            ? "尚未取得可验证的平台模型状态。请先在平台总览核实中转状态。"
            : model.modelStatus.state !== "ready"
              ? "平台模型状态为「" + modelStateLabel(model.modelStatus.state) + "」，计费倍率配置读取暂时关闭。请先处理模型上线门禁。"
              : "模型中转尚未确认已配置，计费倍率配置读取暂时关闭。请先处理平台总览中的中转状态。";

  return (
    <OpsPage
      eyebrow="MODEL BILLING"
      title="模型计费设置"
      description="模型状态与用量已归入平台总览；这里保留旧链接并直达唯一可编辑的计费倍率。"
      nextStep="调整倍率前确认成本证据与变更原因；历史账单不会回溯重算。"
      actions={<Button onClick={() => onNavigate("overview")}>查看平台总览</Button>}
    >
      <Alert
        className="ops-models-merged-alert"
        type="info"
        showIcon
        title="模型服务页已合并"
        description={sections.includes("model-markup")
          ? "运行时健康、五模态能力和平台用量请从总览查看；这里保留计费倍率设置。"
          : "运行时健康、五模态能力和平台用量请从总览查看；当前会话没有商业计费读取权限，因此不展示计费倍率设置。"}
      />
      {sections.includes("model-markup") ? relayReady
        ? <ModelMarkupPanel model={model} />
        : <Alert type="warning" showIcon title="模型中转状态未通过读取门禁" description={relayGateMessage} />
        : null}
    </OpsPage>
  );
}
