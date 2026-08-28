import { ModelMarkupPanel } from "../components/finance/ModelMarkupPanel";
import { ModelStatusSection } from "../components/models/ModelStatusSection";
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { visibleModelsPageSections } from "./modelsPageVisibility";

interface ModelsPageProps {
  model: OpsConsoleModel;
}

export function ModelsPage({ model }: ModelsPageProps) {
  const visibleSections = visibleModelsPageSections(model.canModelMarkup);
  return (
    <OpsPage
      eyebrow="MODEL SERVICES"
      title="模型服务"
      description="集中查看文本、图片、编辑、OCR 与视频能力的最终 readiness、成本证据和上线阻断。"
    >
      <OpsPageError error={model.error} onRetry={() => void model.load()} />
      <ModelStatusSection model={model} />
      {visibleSections.includes("model-markup") ? (
        <ModelMarkupPanel model={model} />
      ) : null}
    </OpsPage>
  );
}
